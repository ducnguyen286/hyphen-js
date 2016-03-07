/**
 * Hyphen Js - Generic Angular application data layer
 * @version v0.0.206 - 2016-03-07 * @link 
 * @author Blazej Grzelinski
 * @license MIT License, http://www.opensource.org/licenses/MIT
 */var jsHyphen = angular.module('jsHyphen', []);

(function () {

    //var publicApi = {};
    //jsHyphen.value('jsHyphen', publicApi);

    jsHyphen.provider("Hyphen", [function () {
        var provider = {};
        provider.initialize = function () {

        };
        provider.$get = ['$rootScope', '$http', '$q', 'BasicModel', 'HyphenIndexDb', '$injector', '$timeout', 'CacheService', 'HyphenSynchronizer', 'OfflineOnlineService',
            function ($rootScope, $http, $q, BasicModel, HyphenIndexDb, $injector, $timeout, CacheService, HyphenSynchronizer, OfflineOnlineService) {
                var service = {};
                var hyphenConfiguration;
                var hyphenIndexDb;
                var stores = [];
                var storesToRemove = [];
                var hyphenSynchronizer;

                service.initialize = function (configuration) {
                    this.configuration = configuration;
                    hyphenConfiguration = configuration;
                    hyphenSynchronizer = new HyphenSynchronizer(configuration);

                    configuration.model.forEach(function (entity) {
                        service[entity.model] = new BasicModel(entity, configuration);
                        var str = {
                            name: entity.model,
                            key: entity.key,
                            priority: entity.priority,
                            sync: entity.sync,
                            foreignKeys: entity.foreignKeys
                        };

                        if (entity.sync) {
                            stores.push(str);
                        } else {
                            storesToRemove.push(str);
                        }
                    });
                };

                service.dispose = function () {
                    CacheService.clearCache();
                    HyphenIndexDb.closeDb();
                };

                service.getState = function () {
                    return OfflineOnlineService.getState();
                };

                service.switchToOffline = function () {
                    OfflineOnlineService.setOffline();
                };
                service.switchToOnline = function () {
                    OfflineOnlineService.setOnline();
                };

                service.initializeDb = function (identifier) {
                    if (!identifier) {
                        throw new Error("Db identifier not provided for initializeDb function");
                    }
                    if (!HyphenIndexDb.isInitialized()) {
                        var dbName = this.configuration.dbName + identifier;
                        hyphenIndexDb = new HyphenIndexDb(dbName, this.configuration.dbVersion, stores, identifier);
                        HyphenIndexDb.upgradeEvent(function (event) {
                            _(stores).each(function (st) {
                                if (!_(event.target.transaction.db.objectStoreNames).contains(st.name)) {
                                    HyphenIndexDb.createStore(st.name, st.key);
                                } else {
                                    //the only one way to not use key path on stores anymore....
                                    if(event.target.transaction.objectStore(st.name).keyPath){
                                        var result= HyphenIndexDb.removeStore(st.name);
                                        result.onsuccess = function (event) {
                                            HyphenIndexDb.createStore(st.name, st.key);
                                        }
                                        request.onerror = function (event) {
                                            console.log(event);
                                        }
                                    }
                                    console.log("Store " + st + "already exist and will be not created again");
                                }
                            });

                            _(storesToRemove).each(function (st) {
                                if (_(event.target.transaction.db.objectStoreNames).contains(st.name)) {
                                    HyphenIndexDb.removeStore(st.name);
                                }
                            });
                        });

                        //event called from indexed db
                        HyphenIndexDb.openEvent(function () {
                            readFromIndexDb(stores);
                        });
                    } else {
                        console.log("db already initialized");
                    }
                };

                $rootScope.$on('hyphenOnline', function (event) {
                    if (hyphenIndexDb) {
                        readFromIndexDb(stores);
                    }
                });

                var syncModelsPromise;
                var readFromIndexDb = function (dbStores) {
                    syncModelsPromise = $q.defer();
                    var readPromises = [];
                    _(dbStores).each(function (store) {
                        var indexReadPromise = HyphenIndexDb.getStoreData(store);
                        readPromises.push(indexReadPromise);
                    });

                    $q.all(readPromises).then(function (result) {
                        hyphenSynchronizer.synchronize(result);
                    }, function (reason) {
                        console.log(reason);
                    });

                    return readPromises;
                }

                return service;
            }];
        return provider;
    }]);

    jsHyphen.factory("HyphenSynchronizer", ['$rootScope', 'HyphenDataStore', '$injector', 'HyphenIndexDb', '$q', function ($rootScope, HyphenDataStore, $injector, HyphenIndexDb, $q) {

        var HyphenSynchronizer = function (configuration) {
            this.configuration = configuration;
        }

        HyphenSynchronizer.prototype.syncedStors = [];

        HyphenSynchronizer.prototype.sortStores = function (stores) {
            return _(stores).sortBy(function (d) {
                return d.model.priority;
            });
        }

        HyphenSynchronizer.prototype.chainStoreSync = function (stores) {
            var self = this;
            var store = this.stores[0];
            if (store) {
                if (store.data.length > 0)
                    self.syncedStors.push(angular.copy(store));
                $rootScope.$broadcast("syncStoreStart", store);
                self.synchronizeStore(store).then(function (result) {
                    $rootScope.$broadcast("syncStoreSuccess", store, result);
                    stores.shift();
                    self.chainStoreSync(stores);
                }, function (reason) {
                    $rootScope.$broadcast("syncError", reason);
                })
            } else {
                $rootScope.$broadcast("syncSuccess", self.syncedStors);
                self.syncedStors = [];
            }
        }

        HyphenSynchronizer.prototype.synchronize = function (stores) {
            $rootScope.$broadcast("syncStart", stores);

            this.stores = this.sortStores(stores);
            this.chainStoreSync(this.stores);
        }
        HyphenSynchronizer.prototype.synchronizeStore = function (syncStore) {
            var self = this;
            var syncPromises = [];
            if (syncStore.data.length > 0) {
                var entitySyncModel = $injector.get(syncStore.model.name);
                _(syncStore.data).each(function (record) {
                    var promise;
                    var id = record[syncStore.model.key];
                    $rootScope.$broadcast("syncRecordStart", record);
                    switch (record.action) {
                        case "new":
                            promise = entitySyncModel.new(angular.copy(record)).then(function (result) {
                                self.updateIds(id, result.data[syncStore.model.key], syncStore.model.key, syncStore.model.foreignKeys);
                                HyphenDataStore.getStores()[syncStore.model.name].remove(id);
                                HyphenIndexDb.deleteRecord(syncStore.model.name, id);
                                $rootScope.$broadcast("syncRecordSuccess", result);
                            }, function (error) {
                                console.log("can not remove synchronized record for 'Add' action with id = " + error);
                            });
                            break;
                        case "updated":
                            promise = entitySyncModel.update(record).then(function (result) {
                                HyphenIndexDb.deleteRecord(syncStore.model.name, id);
                                $rootScope.$broadcast("syncRecordSuccess", result);
                            }, function (error) {
                                console.log("can not remove synchronized record for 'Update' action with id = " + error);
                            });
                            break;
                        case "deleted":
                            promise = entitySyncModel.delete(record).then(function (result) {
                                HyphenIndexDb.deleteRecord(syncStore.model.name, record[syncStore.model.key]);
                                $rootScope.$broadcast("syncRecordSuccess", result);
                            }, function (error) {
                                console.log("can not remove synchronized record for 'Delete' action with id = record[syncStore.model.key]. " + error);
                            });

                            break;
                        default:
                            console.log("action not defined");
                    }
                    syncPromises.push(promise);
                })
            }
            return $q.all(syncPromises);
        }

        HyphenSynchronizer.prototype.updateIds = function (oldId, newId, key, foreignKeys) {
            _(this.stores).each(function (store) {
                _(store.data).each(function (data) {
                    _(foreignKeys).each(function (fKey) {
                        if (Number(data[fKey]) === Number(oldId)) {
                            data[fKey] = newId;
                        }
                    });
                })
            });
        };

        HyphenSynchronizer.prototype.removeSyncedRecord = function (oldId, key) {
            _(this.stores).each(function (store) {
                store.data = _(store.data).filter(function (data) {
                    return data[key] === oldId
                })
            });
        };

        return HyphenSynchronizer;

    }]);

    jsHyphen.factory("HyphenDataStore", ['HyphenDataModel', function (HyphenDataModel) {
        var HyphenDataStore = function (store, entityModel, key) {
            HyphenDataStore.prototype.stores[store] = new HyphenDataModel(entityModel, store, key);
        }

        HyphenDataStore.prototype.stores = {}
        HyphenDataStore.actions = {};

        HyphenDataStore.actions.delete = function (data, store) {
            HyphenDataStore.prototype.stores[store].removeDataOnline(data);
        }

        HyphenDataStore.actions.save = function (data, store) {
            HyphenDataStore.prototype.stores[store].addData(data);
        }

        HyphenDataStore.actions.custom = function (data, store, options) {
            options.responseHandler(data, HyphenDataStore.actions);
        }

        HyphenDataStore.saveResult = function (data, store, options) {
            if (options.processResponse !== false) {
                if (options.responseHandler) {
                    options.responseHandler(data, HyphenDataStore.prototype.stores);

                } else {
                    if (options.method === "delete" || options.action === "delete") {
                        HyphenDataStore.prototype.stores[store].remove(data);
                    }
                    else {
                        HyphenDataStore.prototype.stores[store].add(data);
                    }
                }
            }
        };

        HyphenDataStore.getStores = function () {
            return HyphenDataStore.prototype.stores;
        }

        HyphenDataStore.clearStores = function () {
            _(HyphenDataStore.prototype.stores).each(function (st) {
                st.data = [];
            });
        }

        return HyphenDataStore;
    }]);

    jsHyphen.factory("BasicModel", ['ApiCallFactory', 'HyphenDataStore', '$injector', '$q', 'CacheService', 'OfflineOnlineService', function
        (ApiCallFactory, HyphenDataStore, $injector, $q, CacheService, OfflineOnlineService) {
        var BasicModel = function (modelData, configuration) {
            this.entityModel = null;
            try {
                this.entityModel = $injector.get(modelData.model);
            } catch (e) {
                throw new Error("Model not defned for: " + modelData.model + e.message);
            }
            var dataStore = new HyphenDataStore(modelData.model, this.entityModel, modelData.key);

            //entities public properties
            this.dataModel = dataStore.stores[modelData.model];
            this.api = {};
            this.api.loading = 0;
            var apiCallFactory = new ApiCallFactory();
            _(modelData.rest).each(function (rest) {
                var self = this;
                var apiCall = apiCallFactory.createApiCall(rest, configuration, modelData.model);
                this.api[rest.name] = {};
                self.api[rest.name].loading = 0;

                this.api[rest.name].call = function (params) {
                    var promise;
                    //initialize promise for every call!!!
                    var actionPromise = $q.defer();
                    var cacheItem = rest.name + modelData.model + JSON.stringify(params);

                    if (OfflineOnlineService.getState()) {
                        if (!CacheService.isCached(cacheItem)) {
                            apiCall.dataSet = self.api[rest.name].data;
                            promise = apiCall.invoke.call(apiCall, params);
                            self.api[rest.name].loading++;
                            self.api.loading++;
                            self.api[rest.name].loaded = false;
                            promise.then(function (result) {
                                self.api[rest.name].loading--;
                                self.api.loading--;
                                self.api[rest.name].loaded = true;

                                actionPromise.resolve(angular.copy(result));
                                result.data = configuration.responseInterceptor ?
                                    configuration.responseInterceptor(result.data, rest, dataStore.stores[modelData.model]) :
                                    result.data;
                                HyphenDataStore.saveResult(result.data, modelData.model, rest);

                            }, function (reason) {
                                self.api[rest.name].loading--;
                                self.api.loading--;
                                actionPromise.reject(reason);
                            });
                        } else {
                            actionPromise.resolve([]);
                        }
                    } else {
                        if (self.entityModel[rest.name + "Offline"]) {
                            // try {
                            self.entityModel[rest.name + "Offline"](params, self.api[rest.name].data, HyphenDataStore.prototype.stores);
                            actionPromise.resolve(self.api[rest.name].data);
                            //} catch (error) {
                            //    console.warn(error);
                            //    actionPromise.reject("can not save data in offline" + error);
                            // }

                        } else {
                            var message = "No offline method: " + modelData.model + "." + rest.name + "Offline";
                            console.warn(message)
                            throw new Error(message);
                        }
                    }

                    //if the method is defined as callOnce, call method only first time and return empty arry every next time
                    if (rest.cache && rest.method !== "get") {
                        throw new Error("Cache option can be switch on only for get parameters");
                    }

                    if (rest.cache && rest.method === "get" && !CacheService.isCached(cacheItem)) {
                        CacheService.addUrl(cacheItem);
                    }

                    return actionPromise.promise;
                };
            }, this);
        };
        return BasicModel;
    }]);

    jsHyphen.factory("CacheService", ['HyphenDataStore', function (HyphenDataStore) {
        var urls = [];
        this.addUrl = function (url) {
            urls.push(url);
        }

        this.isCached = function (url) {
            var u = _(urls).filter(function (data) {
                return data === url;
            });

            return u.length > 0 ? true : false;
        }

        this.clearCache = function () {
            HyphenDataStore.clearStores();
            urls = [];
        }

        return this;
    }]);

    jsHyphen.factory("ApiCallFactory", ['HyphenPost', 'HyphenGet', 'HyphenPut', 'HyphenDelete',
        function (HyphenPost, HyphenGet, HyphenPut, HyphenDelete) {
            var ApiCallFactory = function () {

            }
            ApiCallFactory.prototype.callType = HyphenGet;
            ApiCallFactory.prototype.createApiCall = function (options, configuration, dataModel) {

                switch (options.method) {
                    case "get":
                        this.callType = HyphenGet;
                        break;
                    case "post":
                        this.callType = HyphenPost;
                        break;
                    case "put":
                        this.callType = HyphenPut;
                        break;
                    case "delete":
                        this.callType = HyphenDelete;
                        break;
                }

                return new this.callType(options, configuration, dataModel);
            };

            return ApiCallFactory;
        }])

    jsHyphen.factory("OfflineOnlineService", ["$rootScope", '$timeout', function ($rootScope, $timeout) {
        var online = true;
        var manualOffline = false;
        var timer;

        this.getState = function () {
            return online;
        }
        this.setOffline = function () {
            online = false;
            manualOffline = true;
            $rootScope.$broadcast("hyphenOffline");
        };

        this.setOnline = function () {
            manualOffline = false;
            online = true;
            $rootScope.$broadcast("hyphenOnline");
        };

        window.addEventListener('online', function () {
            if (!manualOffline) {
                timer = $timeout(function () {
                    online = true;
                    $rootScope.$broadcast("hyphenOnline");
                }, 5000);
            }
        });

        window.addEventListener('offline', function () {
            if (!manualOffline) {
                if (timer) {
                    $timeout.cancel(timer);
                }
                $timeout(function () {
                    online = false;
                    $rootScope.$broadcast("hyphenOffline");
                });
            }
        });

        return this;

    }]);

})
();



jsHyphen.factory("IndexedDbCommandBase", ['$q', function () {
    var IndexedDbCommandBase = function (name, version) {
        var selfObj = this;
        this.indexedDB = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;

        if (!this.indexedDB) {
            console.log("Indexed db not supported, offline mode not supported");
        }

        var request = window.indexedDB.open(name, version);

        request.onsuccess = function (event) {
            selfObj.db = event.target.result;
            selfObj.stores = event.target.result.objectStoreNames;
            if (selfObj.openEvent) {
                selfObj.openEvent(event);
            }
            console.log("Local db initialized");

        }
        request.onerror = function (event) {
            console.log(event);
        };
        request.onupgradeneeded = function (event) {
            selfObj.db = event.target.result;
            if (selfObj.upgradeEvent) {
                selfObj.upgradeEvent(event);
            }
        };

        request.oncomplete = function (event) {
            console.log(event);
        }

    }

    IndexedDbCommandBase.prototype.isInitialized = function () {
        return this.db ? true : false;
    }

    IndexedDbCommandBase.prototype.registerPromise = function (request) {
        var promise = new Promise(function (resolve, reject) {
            request.onsuccess = function (event) {
                resolve({data: event});
            }
            request.onerror = function (event) {
                reject(event);
            };
            request.onupgradeneeded = function (event) {
                resolve({data: event});
            }
            request.oncomplete = function (event) {
                resolve({data: event});
            }
        });
        return promise;

    }

    return IndexedDbCommandBase;
}]);

jsHyphen.factory("IndexedDbCommands", ['$q', 'IndexedDbCommandBase', function ($q, IndexedDbCommandBase) {
    var IndexedDbCommands = function (name, version) {
        IndexedDbCommandBase.call(this, name, version);
    }

    IndexedDbCommands.prototype = Object.create(IndexedDbCommandBase.prototype);

    IndexedDbCommands.prototype.closeDb = function () {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

    IndexedDbCommands.prototype.clearStores = function (stores, realStores) {
        var self = this;
        var promise;
        var request;
        if (realStores.length > 0) {

            Object.keys(stores).forEach(function (prop) {
                request = self.db.deleteObjectStore(stores[prop].name);
            });

            promise = new Promise(function (resolve, reject) {
                request.onsuccess = function (event) {
                    resolve({data: event});
                }
                request.onerror = function (event) {
                    reject(event);
                };
                request.onupgradeneeded = function (event) {
                    resolve({data: event});
                }
                request.oncomplete = function (event) {
                    resolve({data: event});
                }
            });

        } else {
            promise = new Promise(function (resolve) {
                resolve();
            });
        }

        return promise;
    }

    IndexedDbCommands.prototype.createStore = function (store, key) {
        var request = this.db.createObjectStore(store, {
            autoIncrement: false
        });

        return request;
    }

    IndexedDbCommands.prototype.removeStore = function (store) {
        var request = this.db.deleteObjectStore(store);
        return request;
    }

    IndexedDbCommands.prototype.clear = function (store) {
        var transaction = this.db.transaction(store, "readwrite");
        var storeObject = transaction.objectStore(store)
        var request = storeObject.clear();
        return this.registerPromise(request);
    }

    IndexedDbCommands.prototype.clearSynchronized = function (store) {
        var transaction = this.db.transaction(store, "readwrite");
        var dbStore = transaction.objectStore(store);
        var request = dbStore.openCursor();
        request.onsuccess = function (event) {
            var cursor = event.target.result;
            if (cursor) {
                if (cursor.value.action) {
                    dbStore.delete(cursor.value);
                }
                cursor.continue();
            } else {
            }
        }
    }

    IndexedDbCommands.prototype.createStores = function (stores) {
        var promise;
        var request;
        for (var prop in stores) {
            request = this.db.createObjectStore(stores[prop].name, {
                autoIncrement: false,
                keyPath: stores[prop].key
            });
        }

        promise = new Promise(function (resolve, reject) {
            request.onsuccess = function (event) {
                resolve({data: event});
            }
            request.onerror = function (event) {
                reject(event);
            };
            request.onupgradeneeded = function (event) {
                resolve({data: event});
            }
            request.oncomplete = function (event) {
                resolve({data: event});
            }
        });

        return promise;
    }

    IndexedDbCommands.prototype.addRecord = function (data, store, id) {
        var transaction = this.db.transaction(store, "readwrite");
        var storeObject = transaction.objectStore(store);
        storeObject.add(data, id);
    }

    IndexedDbCommands.prototype.addOrUpdateRecord = function (record, store, id) {
        var self = this;
        var transaction = this.db.transaction(store, "readwrite");
        var storeObject = transaction.objectStore(store);
        var request = storeObject.get(id);
        request.onerror = function () {
            console.log('can not get record ' + record);
        };
        request.onsuccess = function () {
            // Do something with the request.result!
            if (request.result) {
                self.updateRecord(record, store, id);
            } else {
                self.addRecord(record, store, id);
            }
        };
    }

    IndexedDbCommands.prototype.updateRecord = function (data, store, id) {
        var objectStore = this.db.transaction(store, "readwrite").objectStore(store);
        var request = objectStore.get(id);
        request.onsuccess = function () {
            objectStore.put(data, id);
        };
    }

    IndexedDbCommands.prototype.deleteRecord = function (store, id) {
        var objectStore = this.db.transaction(store, "readwrite").objectStore(store);
        objectStore.delete(id);
    }

    IndexedDbCommands.prototype.getStoreData = function (store) {
        var transaction = this.db.transaction(store.name, "readwrite");
        var dbStore = transaction.objectStore(store.name);
        var request = dbStore.openCursor();
        var data = [];
        var deferred = $q.defer();
        request.onsuccess = function (event) {
            var cursor = event.target.result;
            if (cursor) {
                data.push(cursor.value);
                cursor.continue();
            } else {
                deferred.resolve({data: data, model: store});
            }
        }
        request.onerror = function (event) {
            deferred.resolve(event);
        };
        return deferred.promise;
    }

    return IndexedDbCommands;
}])
;

jsHyphen.factory("HyphenIndexDb", ['IndexedDbCommands', function (IndexedDbCommands) {

    var indexedDb;
    var HyphenIndexDb = function (name, version, stores) {
        indexedDb = new IndexedDbCommands(name, version, stores);
    };

    HyphenIndexDb.clearStores = function (stores, realStores) {
        return indexedDb.clearStores(stores, realStores);
    }

    HyphenIndexDb.getStoreData = function (store) {
        return indexedDb.getStoreData(store);
    }

    HyphenIndexDb.createStoremoveStoreres = function (stores) {
        return indexedDb.createStores(stores);
    }

    HyphenIndexDb.removeStore = function (stores) {
        return indexedDb.removeStore(stores);
    }

    HyphenIndexDb.close = function () {
        return indexedDb.closeDb();
    }

    HyphenIndexDb.addRecordToStore = function (data, store, id) {
        return indexedDb.addRecord(data, store, id);
    }
    HyphenIndexDb.updateRecordStore = function (data, store, id) {
        return indexedDb.updateRecord(data, store, id);
    }
    HyphenIndexDb.deleteRecord = function (store, id) {
        return indexedDb.deleteRecord(store, id);
    }

    HyphenIndexDb.upgradeEvent = function (method) {
        return indexedDb.upgradeEvent = method;
    }

    HyphenIndexDb.openEvent = function (method) {
        return indexedDb.openEvent = method;
    }

    HyphenIndexDb.createStore = function (store, key) {
        return indexedDb.createStore(store, key);
    }
    HyphenIndexDb.clear = function (store) {
        return indexedDb.clear(store);
    }
    HyphenIndexDb.getStores = function () {
        return indexedDb.stores;
    }
    HyphenIndexDb.clearSynchronized = function (store) {
        return indexedDb.clearSynchronized(store);
    }
    HyphenIndexDb.addOrUpdateRecord = function (record, store, id) {
        return indexedDb.addOrUpdateRecord(record, store, id);
    }
    HyphenIndexDb.isInitialized = function () {
        if (indexedDb) {
            return indexedDb.isInitialized();
        }
        else {
            return false;
        }
    }
    HyphenIndexDb.closeDb = function () {
        if (indexedDb) {
            indexedDb.closeDb();
        }
    }

    return HyphenIndexDb;
}]);
jsHyphen.factory("HyphenDataModel", ['HyphenIndexDb', 'OfflineOnlineService', function (HyphenIndexDb, OfflineOnlineService) {
    var HyphenDataModel = function (model, name, key) {
        this.model = model;
        this.modelName = name;
        this.key = key;
        this.data = [];
        var self = this;
        this.sorted = false;
        if (model.indexes) {
            Object.keys(model.indexes).forEach(function (key) {
                self["getBy" + model.indexes[key]] = function (id) {
                    if (!self["index" + model.indexes[key]]) {
                        self["index" + model.indexes[key]] = _(self.getData()).indexBy(function (data) {
                            return data[key];
                        });
                    }

                    return self["index" + model.indexes[key]][id];
                };
            });
        }

        if (model.groups) {
            Object.keys(model.groups).forEach(function (key) {
                self["getGroupBy" + model.groups[key]] = function (id) {
                    if (!self["group" + model.groups[key]]) {
                        self["group" + model.groups[key]] = _(self.getData()).groupBy(function (data) {
                            return data[key];
                        });
                    }

                    return self["group" + model.groups[key]][id];
                };
            });
        }
    };

    HyphenDataModel.prototype.data = [];

    var clearIndexes = function () {
        var self = this;
        if (self.model.indexes) {
            Object.keys(self.model.indexes).forEach(function (key) {
                self["index" + self.model.indexes[key]] = null;
            });
        }
    };

    var clearGroups = function () {
        var self = this;
        if (self.model.groups) {
            Object.keys(self.model.groups).forEach(function (key) {
                self["group" + self.model.groups[key]] = null;
            });
        }
    };

    HyphenDataModel.prototype.getData = function () {
        var self = this;

        if (self.model.sort && !self.sorted) {
            this.data = this.data = _(this.data).sortBy(function (ob) {
                if (self.model.sort.desc) {
                    if (ob[self.model.sort.desc]) {
                        return ob[self.model.sort.desc].toLowerCase();
                    } else {
                        return ob[self.model.sort.desc];
                    }
                }
                if (self.model.sort.asc) {
                    if (ob[self.model.sort.asc]) {
                        return ob[self.model.sort.asc].toLowerCase();
                    } else {
                        return ob[self.model.sort.asc];
                    }
                }
            });
            if (self.model.sort.desc) {
                this.data = this.data.reverse();
            }
            self.sorted = true;
            // console.log(this.data)
        }
        return this.data;
    };

    HyphenDataModel.prototype.where = function (condition) {
        return _(this.data).filter(function (el) {
            return el[condition.prop] === condition.value;
        });
    };

    HyphenDataModel.prototype.remove = function (dataParam, preventSync) {
        var self = this;
        var key = self.key;
        var data = Array.isArray(dataParam) ? dataParam : [dataParam];
        _(data).each(function (record) {
            //if app is in online mode or user explicit set prevent sync flag
            if (OfflineOnlineService.getState() || preventSync) {
                //HyphenIndexDb.deleteRecord(self.modelName, record[key]);
                var id = (record && record[key]) ? record[key] : record;
                this.data = _(this.data).filter(function (element) {
                    return element[key] !== id;
                });
            } else {
                if (record.action === "new") {
                    HyphenIndexDb.deleteRecord(self.modelName, record[key]);
                }
                else {
                    record.action = "deleted";
                    HyphenIndexDb.addOrUpdateRecord(record, self.modelName, record[key]);
                }

                var delId = (record && record[key]) ? record[key] : record;
                this.data = _(this.data).filter(function (element) {
                    return element[key] !== delId;
                });

            }
        }, this);

        clearIndexes.call(this);
        clearGroups.call(this);
        self.sorted = false;

    };

    HyphenDataModel.prototype.add = function (records, preventSync) {
        var self = this;
        var addData = JSON.parse(JSON.stringify(records));
        var key = self.key;
        var data = Array.isArray(addData) ? addData : [addData];

        _(data).each(function (record) {
            if (!record[key]) {
                throw new Error("Key is not defined for '" + self.modelName + "', record cannot be added. Record" + record);
            }

            var element = _(self.data).find(function (el) {
                return el[key] === record[key];
            });

            //update
            if (element) {
                var newRecord = _.extend(new self.model(record), record);
                self.data = _([newRecord].concat(self.data)).uniq(false, function (element) {
                    return element[key];
                });

                if (!OfflineOnlineService.getState() && !preventSync) {
                    if (record.action !== "new") {
                        record.action = "updated";
                    }
                    HyphenIndexDb.updateRecordStore(record, self.modelName, record[key]);
                }
            } else {
                //create
                if (!OfflineOnlineService.getState() && !preventSync) {
                    record.action = "new";
                    HyphenIndexDb.addRecordToStore(record, self.modelName, record[key]);
                }
                record = _.extend(new self.model(record), record);
                self.data.push(record);
            }
        });

        clearIndexes.call(this);
        clearGroups.call(this);
        self.sorted = false;
    };

    return HyphenDataModel;
}])
;
/**
 * Created by blazejgrzelinski on 25/11/15.
 */
jsHyphen.factory('HyphenCallBase', ['$http', function ($http) {
    var HyphenCallBase = function (httpOptions, hyphenConfiguration) {
        this.httpOptions = httpOptions;
        this.hyphenConfiguration = hyphenConfiguration;
        this.$http = $http;
        this.config = {};
    };

    HyphenCallBase.prototype.urlParser = function (url, params) {

        for (var property in params) {
            url = url.replace(":" + property, params[property]);
        }
        return url;
    };

    var strEndsWith = function (str, suffix) {
        return str.match(suffix + "$") === suffix;
    };

    HyphenCallBase.prototype.invoke = function (params) {
        this.config = angular.copy(this.httpOptions);
        var url = "";
        if (!strEndsWith(this.hyphenConfiguration.baseUrl, "/")) {
            url = this.hyphenConfiguration.baseUrl;
        }

        if (params) {
            this.config.url = url + this.urlParser(this.httpOptions.url, params);
        } else {
            this.config.url = url + this.httpOptions.url;
        }

        this.config.data = this.dataSet;
        if (this.hyphenConfiguration.requestInterceptor) {
            this.config = this.hyphenConfiguration.requestInterceptor(this.config);
        }

        //hyphen cache property is the same like the native $http cache so it prevent from making http request
        this.config.cache = false;
        return this.$http(this.config);
    };

    return HyphenCallBase;

}]);

jsHyphen.factory("HyphenGet", ['HyphenCallBase', function (HyphenCallBase) {
    var HyphenGet = function (httpOptions, hyphenConfiguration) {
        HyphenCallBase.call(this, httpOptions, hyphenConfiguration);
        this.config.method = "GET";
    };
    HyphenGet.prototype = Object.create(HyphenCallBase.prototype);

    return HyphenGet;

}]);

jsHyphen.factory("HyphenPost", ['HyphenCallBase', function (HyphenCallBase) {
    var HyphenPost = function (httpOptions, hyphenConfiguration) {
        HyphenCallBase.call(this, httpOptions, hyphenConfiguration);
        this.config.method = "POST";
    };

    HyphenPost.prototype = Object.create(HyphenCallBase.prototype);

    HyphenPost.prototype.dataSet = null;

    return HyphenPost;
}]);

jsHyphen.factory("HyphenPut", ['HyphenCallBase', function (HyphenCallBase) {
    var HyphenPut = function (httpOptions, hyphenConfiguration) {
        HyphenCallBase.call(this, httpOptions, hyphenConfiguration);
        this.httpOptions = httpOptions;
        this.config.method = "PUT";
    };

    HyphenPut.prototype = Object.create(HyphenCallBase.prototype);

    HyphenPut.prototype.dataSet = null;

    return HyphenPut;
}]);

jsHyphen.factory("HyphenDelete", ['HyphenCallBase', function (HyphenCallBase) {
    var HyphenDelete = function (httpOptions, hyphenConfiguration) {
        HyphenCallBase.call(this, httpOptions, hyphenConfiguration);
        this.httpOptions = httpOptions;
        this.config.method = "DELETE";
    };

    HyphenDelete.prototype = Object.create(HyphenCallBase.prototype);

    return HyphenDelete;
}]);