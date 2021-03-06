"format global";
(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  var getOwnPropertyDescriptor = true;
  try {
    Object.getOwnPropertyDescriptor({ a: 0 }, 'a');
  }
  catch(e) {
    getOwnPropertyDescriptor = false;
  }

  var defineProperty;
  (function () {
    try {
      if (!!Object.defineProperty({}, 'a', {}))
        defineProperty = Object.defineProperty;
    }
    catch (e) {
      defineProperty = function(obj, prop, opt) {
        try {
          obj[prop] = opt.value || opt.get.call(obj);
        }
        catch(e) {}
      }
    }
  })();

  function register(name, deps, declare) {
    if (arguments.length === 4)
      return registerDynamic.apply(this, arguments);
    doRegister(name, {
      declarative: true,
      deps: deps,
      declare: declare
    });
  }

  function registerDynamic(name, deps, executingRequire, execute) {
    doRegister(name, {
      declarative: false,
      deps: deps,
      executingRequire: executingRequire,
      execute: execute
    });
  }

  function doRegister(name, entry) {
    entry.name = name;

    // we never overwrite an existing define
    if (!(name in defined))
      defined[name] = entry;

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }


  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];

      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;

      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {

        // if already in a group, remove from the old group
        if (depEntry.groupIndex !== undefined) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;

      if (typeof name == 'object') {
        for (var p in name)
          exports[p] = name[p];
      }
      else {
        exports[name] = value;
      }

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          for (var j = 0; j < importerModule.dependencies.length; ++j) {
            if (importerModule.dependencies[j] === module) {
              importerModule.setters[j](exports);
            }
          }
        }
      }

      module.locked = false;
      return value;
    });

    module.setters = declaration.setters;
    module.execute = declaration.execute;

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        depExports = depEntry.esModule;
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw new Error("Unable to load dependency " + name + ".");
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);

      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }

    if ((!entry || entry.declarative) && exports && exports.__useDefault)
      return exports['default'];

    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
      throw new TypeError('Module ' + name + ' not declared as a dependency.');
    }, exports, module);

    if (output)
      module.exports = output;

    // create the esModule object, which allows ES6 named imports of dynamics
    exports = module.exports;
 
    if (exports && exports.__esModule) {
      entry.esModule = exports;
    }
    else {
      entry.esModule = {};
      
      // don't trigger getters/setters in environments that support them
      if (typeof exports == 'object' || typeof exports == 'function') {
        if (getOwnPropertyDescriptor) {
          var d;
          for (var p in exports)
            if (d = Object.getOwnPropertyDescriptor(exports, p))
              defineProperty(entry.esModule, p, d);
        }
        else {
          var hasOwnProperty = exports && exports.hasOwnProperty;
          for (var p in exports) {
            if (!hasOwnProperty || exports.hasOwnProperty(p))
              entry.esModule[p] = exports[p];
          }
         }
       }
      entry.esModule['default'] = exports;
      defineProperty(entry.esModule, '__useDefault', {
        value: true
      });
    }
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (!entry || entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    // node core modules
    if (name.substr(0, 6) == '@node/')
      return require(name.substr(6));

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    // exported modules get __esModule defined for interop
    if (entry.declarative)
      defineProperty(entry.module.exports, '__esModule', { value: true });

    // return the defined module object
    return modules[name] = entry.declarative ? entry.module.exports : entry.esModule;
  };

  return function(mains, depNames, declare) {
    return function(formatDetect) {
      formatDetect(function(deps) {
        var System = {
          _nodeRequire: typeof require != 'undefined' && require.resolve && typeof process != 'undefined' && require,
          register: register,
          registerDynamic: registerDynamic,
          get: load, 
          set: function(name, module) {
            modules[name] = module; 
          },
          newModule: function(module) {
            return module;
          }
        };
        System.set('@empty', {});

        // register external dependencies
        for (var i = 0; i < depNames.length; i++) (function(depName, dep) {
          if (dep && dep.__esModule)
            System.register(depName, [], function(_export) {
              return {
                setters: [],
                execute: function() {
                  for (var p in dep)
                    if (p != '__esModule' && !(typeof p == 'object' && p + '' == 'Module'))
                      _export(p, dep[p]);
                }
              };
            });
          else
            System.registerDynamic(depName, [], false, function() {
              return dep;
            });
        })(depNames[i], arguments[i]);

        // register modules in this bundle
        declare(System);

        // load mains
        var firstLoad = load(mains[0]);
        if (mains.length > 1)
          for (var i = 1; i < mains.length; i++)
            load(mains[i]);

        if (firstLoad.__useDefault)
          return firstLoad['default'];
        else
          return firstLoad;
      });
    };
  };

})(typeof self != 'undefined' ? self : global)
/* (['mainModule'], ['external-dep'], function($__System) {
  System.register(...);
})
(function(factory) {
  if (typeof define && define.amd)
    define(['external-dep'], factory);
  // etc UMD / module pattern
})*/

(['1', '2', '3', '4'], [], function($__System) {

(function(__global) {
  var loader = $__System;
  var hasOwnProperty = Object.prototype.hasOwnProperty;
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  function readMemberExpression(p, value) {
    var pParts = p.split('.');
    while (pParts.length)
      value = value[pParts.shift()];
    return value;
  }

  // bare minimum ignores for IE8
  var ignoredGlobalProps = ['_g', 'sessionStorage', 'localStorage', 'clipboardData', 'frames', 'external', 'mozAnimationStartTime', 'webkitStorageInfo', 'webkitIndexedDB'];

  var globalSnapshot;

  function forEachGlobal(callback) {
    if (Object.keys)
      Object.keys(__global).forEach(callback);
    else
      for (var g in __global) {
        if (!hasOwnProperty.call(__global, g))
          continue;
        callback(g);
      }
  }

  function forEachGlobalValue(callback) {
    forEachGlobal(function(globalName) {
      if (indexOf.call(ignoredGlobalProps, globalName) != -1)
        return;
      try {
        var value = __global[globalName];
      }
      catch (e) {
        ignoredGlobalProps.push(globalName);
      }
      callback(globalName, value);
    });
  }

  loader.set('@@global-helpers', loader.newModule({
    prepareGlobal: function(moduleName, exportName, globals) {
      // disable module detection
      var curDefine = __global.define;
       
      __global.define = undefined;
      __global.exports = undefined;
      if (__global.module && __global.module.exports)
        __global.module = undefined;

      // set globals
      var oldGlobals;
      if (globals) {
        oldGlobals = {};
        for (var g in globals) {
          oldGlobals[g] = globals[g];
          __global[g] = globals[g];
        }
      }

      // store a complete copy of the global object in order to detect changes
      if (!exportName) {
        globalSnapshot = {};

        forEachGlobalValue(function(name, value) {
          globalSnapshot[name] = value;
        });
      }

      // return function to retrieve global
      return function() {
        var globalValue;

        if (exportName) {
          globalValue = readMemberExpression(exportName, __global);
        }
        else {
          var singleGlobal;
          var multipleExports;
          var exports = {};

          forEachGlobalValue(function(name, value) {
            if (globalSnapshot[name] === value)
              return;
            if (typeof value == 'undefined')
              return;
            exports[name] = value;

            if (typeof singleGlobal != 'undefined') {
              if (!multipleExports && singleGlobal !== value)
                multipleExports = true;
            }
            else {
              singleGlobal = value;
            }
          });
          globalValue = multipleExports ? exports : singleGlobal;
        }

        // revert globals
        if (oldGlobals) {
          for (var g in oldGlobals)
            __global[g] = oldGlobals[g];
        }
        __global.define = curDefine;

        return globalValue;
      };
    }
  }));

})(typeof self != 'undefined' ? self : global);

$__System.register("5", [], function() { return { setters: [], execute: function() {} } });

$__System.register("6", [], function() { return { setters: [], execute: function() {} } });

$__System.register("7", [], function() { return { setters: [], execute: function() {} } });

$__System.registerDynamic("8", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  exports.set = function set(obj, key, val) {
    if (obj.hasOwnProperty(key)) {
      obj[key] = val;
      return;
    }
    if (obj._isVue) {
      set(obj._data, key, val);
      return;
    }
    var ob = obj.__ob__;
    if (!ob) {
      obj[key] = val;
      return;
    }
    ob.convert(key, val);
    ob.notify();
    if (ob.vms) {
      var i = ob.vms.length;
      while (i--) {
        var vm = ob.vms[i];
        vm._proxy(key);
        vm._digest();
      }
    }
  };
  exports.delete = function(obj, key) {
    if (!obj.hasOwnProperty(key)) {
      return;
    }
    delete obj[key];
    var ob = obj.__ob__;
    if (!ob) {
      return;
    }
    ob.notify();
    if (ob.vms) {
      var i = ob.vms.length;
      while (i--) {
        var vm = ob.vms[i];
        vm._unproxy(key);
        vm._digest();
      }
    }
  };
  var literalValueRE = /^\s?(true|false|[\d\.]+|'[^']*'|"[^"]*")\s?$/;
  exports.isLiteral = function(exp) {
    return literalValueRE.test(exp);
  };
  exports.isReserved = function(str) {
    var c = (str + '').charCodeAt(0);
    return c === 0x24 || c === 0x5F;
  };
  exports.toString = function(value) {
    return value == null ? '' : value.toString();
  };
  exports.toNumber = function(value) {
    if (typeof value !== 'string') {
      return value;
    } else {
      var parsed = Number(value);
      return isNaN(parsed) ? value : parsed;
    }
  };
  exports.toBoolean = function(value) {
    return value === 'true' ? true : value === 'false' ? false : value;
  };
  exports.stripQuotes = function(str) {
    var a = str.charCodeAt(0);
    var b = str.charCodeAt(str.length - 1);
    return a === b && (a === 0x22 || a === 0x27) ? str.slice(1, -1) : str;
  };
  exports.camelize = function(str) {
    return str.replace(/-(\w)/g, toUpper);
  };
  function toUpper(_, c) {
    return c ? c.toUpperCase() : '';
  }
  exports.hyphenate = function(str) {
    return str.replace(/([a-z\d])([A-Z])/g, '$1-$2').toLowerCase();
  };
  var classifyRE = /(?:^|[-_\/])(\w)/g;
  exports.classify = function(str) {
    return str.replace(classifyRE, toUpper);
  };
  exports.bind = function(fn, ctx) {
    return function(a) {
      var l = arguments.length;
      return l ? l > 1 ? fn.apply(ctx, arguments) : fn.call(ctx, a) : fn.call(ctx);
    };
  };
  exports.toArray = function(list, start) {
    start = start || 0;
    var i = list.length - start;
    var ret = new Array(i);
    while (i--) {
      ret[i] = list[i + start];
    }
    return ret;
  };
  exports.extend = function(to, from) {
    var keys = Object.keys(from);
    var i = keys.length;
    while (i--) {
      to[keys[i]] = from[keys[i]];
    }
    return to;
  };
  exports.isObject = function(obj) {
    return obj !== null && typeof obj === 'object';
  };
  var toString = Object.prototype.toString;
  var OBJECT_STRING = '[object Object]';
  exports.isPlainObject = function(obj) {
    return toString.call(obj) === OBJECT_STRING;
  };
  exports.isArray = Array.isArray;
  exports.define = function(obj, key, val, enumerable) {
    Object.defineProperty(obj, key, {
      value: val,
      enumerable: !!enumerable,
      writable: true,
      configurable: true
    });
  };
  exports.debounce = function(func, wait) {
    var timeout,
        args,
        context,
        timestamp,
        result;
    var later = function() {
      var last = Date.now() - timestamp;
      if (last < wait && last >= 0) {
        timeout = setTimeout(later, wait - last);
      } else {
        timeout = null;
        result = func.apply(context, args);
        if (!timeout)
          context = args = null;
      }
    };
    return function() {
      context = this;
      args = arguments;
      timestamp = Date.now();
      if (!timeout) {
        timeout = setTimeout(later, wait);
      }
      return result;
    };
  };
  exports.indexOf = function(arr, obj) {
    var i = arr.length;
    while (i--) {
      if (arr[i] === obj)
        return i;
    }
    return -1;
  };
  exports.cancellable = function(fn) {
    var cb = function() {
      if (!cb.cancelled) {
        return fn.apply(this, arguments);
      }
    };
    cb.cancel = function() {
      cb.cancelled = true;
    };
    return cb;
  };
  exports.looseEqual = function(a, b) {
    return a == b || (exports.isObject(a) && exports.isObject(b) ? JSON.stringify(a) === JSON.stringify(b) : false);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("9", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  exports.hasProto = '__proto__' in {};
  var inBrowser = exports.inBrowser = typeof window !== 'undefined' && Object.prototype.toString.call(window) !== '[object Object]';
  exports.isIE9 = inBrowser && navigator.userAgent.toLowerCase().indexOf('msie 9.0') > 0;
  exports.isAndroid = inBrowser && navigator.userAgent.toLowerCase().indexOf('android') > 0;
  if (inBrowser && !exports.isIE9) {
    var isWebkitTrans = window.ontransitionend === undefined && window.onwebkittransitionend !== undefined;
    var isWebkitAnim = window.onanimationend === undefined && window.onwebkitanimationend !== undefined;
    exports.transitionProp = isWebkitTrans ? 'WebkitTransition' : 'transition';
    exports.transitionEndEvent = isWebkitTrans ? 'webkitTransitionEnd' : 'transitionend';
    exports.animationProp = isWebkitAnim ? 'WebkitAnimation' : 'animation';
    exports.animationEndEvent = isWebkitAnim ? 'webkitAnimationEnd' : 'animationend';
  }
  exports.nextTick = (function() {
    var callbacks = [];
    var pending = false;
    var timerFunc;
    function nextTickHandler() {
      pending = false;
      var copies = callbacks.slice(0);
      callbacks = [];
      for (var i = 0; i < copies.length; i++) {
        copies[i]();
      }
    }
    if (typeof MutationObserver !== 'undefined') {
      var counter = 1;
      var observer = new MutationObserver(nextTickHandler);
      var textNode = document.createTextNode(counter);
      observer.observe(textNode, {characterData: true});
      timerFunc = function() {
        counter = (counter + 1) % 2;
        textNode.data = counter;
      };
    } else {
      timerFunc = setTimeout;
    }
    return function(cb, ctx) {
      var func = ctx ? function() {
        cb.call(ctx);
      } : cb;
      callbacks.push(func);
      if (pending)
        return;
      pending = true;
      timerFunc(nextTickHandler, 0);
    };
  })();
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("a", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  function Cache(limit) {
    this.size = 0;
    this.limit = limit;
    this.head = this.tail = undefined;
    this._keymap = Object.create(null);
  }
  var p = Cache.prototype;
  p.put = function(key, value) {
    var entry = {
      key: key,
      value: value
    };
    this._keymap[key] = entry;
    if (this.tail) {
      this.tail.newer = entry;
      entry.older = this.tail;
    } else {
      this.head = entry;
    }
    this.tail = entry;
    if (this.size === this.limit) {
      return this.shift();
    } else {
      this.size++;
    }
  };
  p.shift = function() {
    var entry = this.head;
    if (entry) {
      this.head = this.head.newer;
      this.head.older = undefined;
      entry.newer = entry.older = undefined;
      this._keymap[entry.key] = undefined;
    }
    return entry;
  };
  p.get = function(key, returnEntry) {
    var entry = this._keymap[key];
    if (entry === undefined)
      return;
    if (entry === this.tail) {
      return returnEntry ? entry : entry.value;
    }
    if (entry.newer) {
      if (entry === this.head) {
        this.head = entry.newer;
      }
      entry.newer.older = entry.older;
    }
    if (entry.older) {
      entry.older.newer = entry.newer;
    }
    entry.newer = undefined;
    entry.older = this.tail;
    if (this.tail) {
      this.tail.newer = entry;
    }
    this.tail = entry;
    return returnEntry ? entry : entry.value;
  };
  module.exports = Cache;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("b", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var process = module.exports = {};
  var queue = [];
  var draining = false;
  var currentQueue;
  var queueIndex = -1;
  function cleanUpNextTick() {
    draining = false;
    if (currentQueue.length) {
      queue = currentQueue.concat(queue);
    } else {
      queueIndex = -1;
    }
    if (queue.length) {
      drainQueue();
    }
  }
  function drainQueue() {
    if (draining) {
      return;
    }
    var timeout = setTimeout(cleanUpNextTick);
    draining = true;
    var len = queue.length;
    while (len) {
      currentQueue = queue;
      queue = [];
      while (++queueIndex < len) {
        if (currentQueue) {
          currentQueue[queueIndex].run();
        }
      }
      queueIndex = -1;
      len = queue.length;
    }
    currentQueue = null;
    draining = false;
    clearTimeout(timeout);
  }
  process.nextTick = function(fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
      for (var i = 1; i < arguments.length; i++) {
        args[i - 1] = arguments[i];
      }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
      setTimeout(drainQueue, 0);
    }
  };
  function Item(fun, array) {
    this.fun = fun;
    this.array = array;
  }
  Item.prototype.run = function() {
    this.fun.apply(null, this.array);
  };
  process.title = 'browser';
  process.browser = true;
  process.env = {};
  process.argv = [];
  process.version = '';
  process.versions = {};
  function noop() {}
  process.on = noop;
  process.addListener = noop;
  process.once = noop;
  process.off = noop;
  process.removeListener = noop;
  process.removeAllListeners = noop;
  process.emit = noop;
  process.binding = function(name) {
    throw new Error('process.binding is not supported');
  };
  process.cwd = function() {
    return '/';
  };
  process.chdir = function(dir) {
    throw new Error('process.chdir is not supported');
  };
  process.umask = function() {
    return 0;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("c", ["b"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = req('b');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("d", ["c"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__System._nodeRequire ? process : req('c');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("e", ["d"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = req('d');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("f", ["10", "a", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var Cache = req('a');
    var cache = new Cache(1000);
    var filterTokenRE = /[^\s'"]+|'[^']*'|"[^"]*"/g;
    var reservedArgRE = /^in$|^-?\d+/;
    var str,
        dir;
    var c,
        i,
        l,
        lastFilterIndex;
    var inSingle,
        inDouble,
        curly,
        square,
        paren;
    function pushFilter() {
      var exp = str.slice(lastFilterIndex, i).trim();
      var filter;
      if (exp) {
        filter = {};
        var tokens = exp.match(filterTokenRE);
        filter.name = tokens[0];
        if (tokens.length > 1) {
          filter.args = tokens.slice(1).map(processFilterArg);
        }
      }
      if (filter) {
        (dir.filters = dir.filters || []).push(filter);
      }
      lastFilterIndex = i + 1;
    }
    function processFilterArg(arg) {
      if (reservedArgRE.test(arg)) {
        return {
          value: arg,
          dynamic: false
        };
      } else {
        var stripped = _.stripQuotes(arg);
        var dynamic = stripped === arg;
        return {
          value: dynamic ? arg : stripped,
          dynamic: dynamic
        };
      }
    }
    exports.parse = function(s) {
      var hit = cache.get(s);
      if (hit) {
        return hit;
      }
      str = s;
      inSingle = inDouble = false;
      curly = square = paren = 0;
      lastFilterIndex = 0;
      dir = {};
      for (i = 0, l = str.length; i < l; i++) {
        c = str.charCodeAt(i);
        if (inSingle) {
          if (c === 0x27)
            inSingle = !inSingle;
        } else if (inDouble) {
          if (c === 0x22)
            inDouble = !inDouble;
        } else if (c === 0x7C && str.charCodeAt(i + 1) !== 0x7C && str.charCodeAt(i - 1) !== 0x7C) {
          if (dir.expression == null) {
            lastFilterIndex = i + 1;
            dir.expression = str.slice(0, i).trim();
          } else {
            pushFilter();
          }
        } else {
          switch (c) {
            case 0x22:
              inDouble = true;
              break;
            case 0x27:
              inSingle = true;
              break;
            case 0x28:
              paren++;
              break;
            case 0x29:
              paren--;
              break;
            case 0x5B:
              square++;
              break;
            case 0x5D:
              square--;
              break;
            case 0x7B:
              curly++;
              break;
            case 0x7D:
              curly--;
              break;
          }
        }
      }
      if (dir.expression == null) {
        dir.expression = str.slice(0, i).trim();
      } else if (lastFilterIndex !== 0) {
        pushFilter();
      }
      cache.put(s, dir);
      return dir;
    };
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("11", ["a", "12", "f"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Cache = req('a');
  var config = req('12');
  var dirParser = req('f');
  var regexEscapeRE = /[-.*+?^${}()|[\]\/\\]/g;
  var cache,
      tagRE,
      htmlRE;
  function escapeRegex(str) {
    return str.replace(regexEscapeRE, '\\$&');
  }
  exports.compileRegex = function() {
    var open = escapeRegex(config.delimiters[0]);
    var close = escapeRegex(config.delimiters[1]);
    var unsafeOpen = escapeRegex(config.unsafeDelimiters[0]);
    var unsafeClose = escapeRegex(config.unsafeDelimiters[1]);
    tagRE = new RegExp(unsafeOpen + '(.+?)' + unsafeClose + '|' + open + '(.+?)' + close, 'g');
    htmlRE = new RegExp('^' + unsafeOpen + '.*' + unsafeClose + '$');
    cache = new Cache(1000);
  };
  exports.parse = function(text) {
    if (!cache) {
      exports.compileRegex();
    }
    var hit = cache.get(text);
    if (hit) {
      return hit;
    }
    text = text.replace(/\n/g, '');
    if (!tagRE.test(text)) {
      return null;
    }
    var tokens = [];
    var lastIndex = tagRE.lastIndex = 0;
    var match,
        index,
        html,
        value,
        first,
        oneTime;
    while (match = tagRE.exec(text)) {
      index = match.index;
      if (index > lastIndex) {
        tokens.push({value: text.slice(lastIndex, index)});
      }
      html = htmlRE.test(match[0]);
      value = html ? match[1] : match[2];
      first = value.charCodeAt(0);
      oneTime = first === 42;
      value = oneTime ? value.slice(1) : value;
      tokens.push({
        tag: true,
        value: value.trim(),
        html: html,
        oneTime: oneTime
      });
      lastIndex = index + match[0].length;
    }
    if (lastIndex < text.length) {
      tokens.push({value: text.slice(lastIndex)});
    }
    cache.put(text, tokens);
    return tokens;
  };
  exports.tokensToExp = function(tokens) {
    if (tokens.length > 1) {
      return tokens.map(function(token) {
        return formatToken(token);
      }).join('+');
    } else {
      return formatToken(tokens[0], true);
    }
  };
  function formatToken(token, single) {
    return token.tag ? inlineFilters(token.value, single) : '"' + token.value + '"';
  }
  var filterRE = /[^|]\|[^|]/;
  function inlineFilters(exp, single) {
    if (!filterRE.test(exp)) {
      return single ? exp : '(' + exp + ')';
    } else {
      var dir = dirParser.parse(exp);
      if (!dir.filters) {
        return '(' + exp + ')';
      } else {
        return 'this._applyFilters(' + dir.expression + ',null,' + JSON.stringify(dir.filters) + ',false)';
      }
    }
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("12", ["11"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    debug: false,
    silent: false,
    async: true,
    warnExpressionErrors: true,
    _delimitersChanged: true,
    _assetTypes: ['component', 'directive', 'elementDirective', 'filter', 'transition', 'partial'],
    _propBindingModes: {
      ONE_WAY: 0,
      TWO_WAY: 1,
      ONE_TIME: 2
    },
    _maxUpdateCount: 100
  };
  var delimiters = ['{{', '}}'];
  var unsafeDelimiters = ['{{{', '}}}'];
  var textParser = req('11');
  Object.defineProperty(module.exports, 'delimiters', {
    get: function() {
      return delimiters;
    },
    set: function(val) {
      delimiters = val;
      textParser.compileRegex();
    }
  });
  Object.defineProperty(module.exports, 'unsafeDelimiters', {
    get: function() {
      return unsafeDelimiters;
    },
    set: function(val) {
      unsafeDelimiters = val;
      textParser.compileRegex();
    }
  });
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("13", ["10"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  exports.append = function(el, target, vm, cb) {
    apply(el, 1, function() {
      target.appendChild(el);
    }, vm, cb);
  };
  exports.before = function(el, target, vm, cb) {
    apply(el, 1, function() {
      _.before(el, target);
    }, vm, cb);
  };
  exports.remove = function(el, vm, cb) {
    apply(el, -1, function() {
      _.remove(el);
    }, vm, cb);
  };
  var apply = exports.apply = function(el, direction, op, vm, cb) {
    var transition = el.__v_trans;
    if (!transition || (!transition.hooks && !_.transitionEndEvent) || !vm._isCompiled || (vm.$parent && !vm.$parent._isCompiled)) {
      op();
      if (cb)
        cb();
      return;
    }
    var action = direction > 0 ? 'enter' : 'leave';
    transition[action](op, cb);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3", ["10", "12", "13", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var config = req('12');
    var transition = req('13');
    exports.query = function(el) {
      if (typeof el === 'string') {
        var selector = el;
        el = document.querySelector(el);
        if (!el) {
          process.env.NODE_ENV !== 'production' && _.warn('Cannot find element: ' + selector);
        }
      }
      return el;
    };
    exports.inDoc = function(node) {
      var doc = document.documentElement;
      var parent = node && node.parentNode;
      return doc === node || doc === parent || !!(parent && parent.nodeType === 1 && (doc.contains(parent)));
    };
    exports.attr = function(node, attr) {
      var val = node.getAttribute(attr);
      if (val !== null) {
        node.removeAttribute(attr);
      }
      return val;
    };
    exports.getBindAttr = function(node, name) {
      var val = exports.attr(node, ':' + name);
      if (val === null) {
        val = exports.attr(node, 'v-bind:' + name);
      }
      return val;
    };
    exports.before = function(el, target) {
      target.parentNode.insertBefore(el, target);
    };
    exports.after = function(el, target) {
      if (target.nextSibling) {
        exports.before(el, target.nextSibling);
      } else {
        target.parentNode.appendChild(el);
      }
    };
    exports.remove = function(el) {
      el.parentNode.removeChild(el);
    };
    exports.prepend = function(el, target) {
      if (target.firstChild) {
        exports.before(el, target.firstChild);
      } else {
        target.appendChild(el);
      }
    };
    exports.replace = function(target, el) {
      var parent = target.parentNode;
      if (parent) {
        parent.replaceChild(el, target);
      }
    };
    exports.on = function(el, event, cb) {
      el.addEventListener(event, cb);
    };
    exports.off = function(el, event, cb) {
      el.removeEventListener(event, cb);
    };
    exports.addClass = function(el, cls) {
      if (el.classList) {
        el.classList.add(cls);
      } else {
        var cur = ' ' + (el.getAttribute('class') || '') + ' ';
        if (cur.indexOf(' ' + cls + ' ') < 0) {
          el.setAttribute('class', (cur + cls).trim());
        }
      }
    };
    exports.removeClass = function(el, cls) {
      if (el.classList) {
        el.classList.remove(cls);
      } else {
        var cur = ' ' + (el.getAttribute('class') || '') + ' ';
        var tar = ' ' + cls + ' ';
        while (cur.indexOf(tar) >= 0) {
          cur = cur.replace(tar, ' ');
        }
        el.setAttribute('class', cur.trim());
      }
      if (!el.className) {
        el.removeAttribute('class');
      }
    };
    exports.extractContent = function(el, asFragment) {
      var child;
      var rawContent;
      if (exports.isTemplate(el) && el.content instanceof DocumentFragment) {
        el = el.content;
      }
      if (el.hasChildNodes()) {
        exports.trimNode(el);
        rawContent = asFragment ? document.createDocumentFragment() : document.createElement('div');
        while (child = el.firstChild) {
          rawContent.appendChild(child);
        }
      }
      return rawContent;
    };
    exports.trimNode = function(node) {
      trim(node, node.firstChild);
      trim(node, node.lastChild);
    };
    function trim(parent, node) {
      if (node && node.nodeType === 3 && !node.data.trim()) {
        parent.removeChild(node);
      }
    }
    exports.isTemplate = function(el) {
      return el.tagName && el.tagName.toLowerCase() === 'template';
    };
    exports.createAnchor = function(content, persist) {
      return config.debug ? document.createComment(content) : document.createTextNode(persist ? ' ' : '');
    };
    var refRE = /^v-ref:/;
    exports.findRef = function(node) {
      if (node.hasAttributes()) {
        var attrs = node.attributes;
        for (var i = 0,
            l = attrs.length; i < l; i++) {
          var name = attrs[i].name;
          if (refRE.test(name)) {
            node.removeAttribute(name);
            return _.camelize(name.replace(refRE, ''));
          }
        }
      }
    };
    exports.mapNodeRange = function(node, end, op) {
      var next;
      while (node !== end) {
        next = node.nextSibling;
        op(node);
        node = next;
      }
      op(end);
    };
    exports.removeNodeRange = function(start, end, vm, frag, cb) {
      var done = false;
      var removed = 0;
      var nodes = [];
      exports.mapNodeRange(start, end, function(node) {
        if (node === end)
          done = true;
        nodes.push(node);
        transition.remove(node, vm, onRemoved);
      });
      function onRemoved() {
        removed++;
        if (done && removed >= nodes.length) {
          for (var i = 0; i < nodes.length; i++) {
            frag.appendChild(nodes[i]);
          }
          cb && cb();
        }
      }
    };
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4", ["10", "12", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var config = req('12');
    var extend = _.extend;
    var strats = config.optionMergeStrategies = Object.create(null);
    function mergeData(to, from) {
      var key,
          toVal,
          fromVal;
      for (key in from) {
        toVal = to[key];
        fromVal = from[key];
        if (!to.hasOwnProperty(key)) {
          _.set(to, key, fromVal);
        } else if (_.isObject(toVal) && _.isObject(fromVal)) {
          mergeData(toVal, fromVal);
        }
      }
      return to;
    }
    strats.data = function(parentVal, childVal, vm) {
      if (!vm) {
        if (!childVal) {
          return parentVal;
        }
        if (typeof childVal !== 'function') {
          process.env.NODE_ENV !== 'production' && _.warn('The "data" option should be a function ' + 'that returns a per-instance value in component ' + 'definitions.');
          return parentVal;
        }
        if (!parentVal) {
          return childVal;
        }
        return function mergedDataFn() {
          return mergeData(childVal.call(this), parentVal.call(this));
        };
      } else if (parentVal || childVal) {
        return function mergedInstanceDataFn() {
          var instanceData = typeof childVal === 'function' ? childVal.call(vm) : childVal;
          var defaultData = typeof parentVal === 'function' ? parentVal.call(vm) : undefined;
          if (instanceData) {
            return mergeData(instanceData, defaultData);
          } else {
            return defaultData;
          }
        };
      }
    };
    strats.el = function(parentVal, childVal, vm) {
      if (!vm && childVal && typeof childVal !== 'function') {
        process.env.NODE_ENV !== 'production' && _.warn('The "el" option should be a function ' + 'that returns a per-instance value in component ' + 'definitions.');
        return;
      }
      var ret = childVal || parentVal;
      return vm && typeof ret === 'function' ? ret.call(vm) : ret;
    };
    strats.init = strats.created = strats.ready = strats.attached = strats.detached = strats.beforeCompile = strats.compiled = strats.beforeDestroy = strats.destroyed = function(parentVal, childVal) {
      return childVal ? parentVal ? parentVal.concat(childVal) : _.isArray(childVal) ? childVal : [childVal] : parentVal;
    };
    strats.paramAttributes = function() {
      process.env.NODE_ENV !== 'production' && _.warn('"paramAttributes" option has been deprecated in 0.12. ' + 'Use "props" instead.');
    };
    function mergeAssets(parentVal, childVal) {
      var res = Object.create(parentVal);
      return childVal ? extend(res, guardArrayAssets(childVal)) : res;
    }
    config._assetTypes.forEach(function(type) {
      strats[type + 's'] = mergeAssets;
    });
    strats.watch = strats.events = function(parentVal, childVal) {
      if (!childVal)
        return parentVal;
      if (!parentVal)
        return childVal;
      var ret = {};
      extend(ret, parentVal);
      for (var key in childVal) {
        var parent = ret[key];
        var child = childVal[key];
        if (parent && !_.isArray(parent)) {
          parent = [parent];
        }
        ret[key] = parent ? parent.concat(child) : [child];
      }
      return ret;
    };
    strats.props = strats.methods = strats.computed = function(parentVal, childVal) {
      if (!childVal)
        return parentVal;
      if (!parentVal)
        return childVal;
      var ret = Object.create(null);
      extend(ret, parentVal);
      extend(ret, childVal);
      return ret;
    };
    var defaultStrat = function(parentVal, childVal) {
      return childVal === undefined ? parentVal : childVal;
    };
    function guardComponents(options) {
      if (options.components) {
        var components = options.components = guardArrayAssets(options.components);
        var def;
        var ids = Object.keys(components);
        for (var i = 0,
            l = ids.length; i < l; i++) {
          var key = ids[i];
          if (_.commonTagRE.test(key)) {
            process.env.NODE_ENV !== 'production' && _.warn('Do not use built-in HTML elements as component ' + 'id: ' + key);
            continue;
          }
          def = components[key];
          if (_.isPlainObject(def)) {
            def.name = def.name || key;
            components[key] = _.Vue.extend(def);
          }
        }
      }
    }
    function guardProps(options) {
      var props = options.props;
      var i;
      if (_.isArray(props)) {
        options.props = {};
        i = props.length;
        while (i--) {
          options.props[props[i]] = null;
        }
      } else if (_.isPlainObject(props)) {
        var keys = Object.keys(props);
        i = keys.length;
        while (i--) {
          var val = props[keys[i]];
          if (typeof val === 'function') {
            props[keys[i]] = {type: val};
          }
        }
      }
    }
    function guardArrayAssets(assets) {
      if (_.isArray(assets)) {
        var res = {};
        var i = assets.length;
        var asset;
        while (i--) {
          asset = assets[i];
          var id = asset.name || (asset.options && asset.options.name);
          if (!id) {
            process.env.NODE_ENV !== 'production' && _.warn('Array-syntax assets must provide a "name" field.');
          } else {
            res[id] = asset;
          }
        }
        return res;
      }
      return assets;
    }
    exports.mergeOptions = function merge(parent, child, vm) {
      guardComponents(child);
      guardProps(child);
      var options = {};
      var key;
      if (child.mixins) {
        for (var i = 0,
            l = child.mixins.length; i < l; i++) {
          parent = merge(parent, child.mixins[i], vm);
        }
      }
      for (key in parent) {
        mergeField(key);
      }
      for (key in child) {
        if (!(parent.hasOwnProperty(key))) {
          mergeField(key);
        }
      }
      function mergeField(key) {
        var strat = strats[key] || defaultStrat;
        options[key] = strat(parent[key], child[key], vm, key);
      }
      return options;
    };
    exports.resolveAsset = function resolve(options, type, id) {
      var assets = options[type];
      var camelizedId;
      return assets[id] || assets[camelizedId = _.camelize(id)] || assets[camelizedId.charAt(0).toUpperCase() + camelizedId.slice(1)];
    };
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2", ["10", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    exports.commonTagRE = /^(div|p|span|img|a|b|i|br|ul|ol|li|h1|h2|h3|h4|h5|h6|code|pre|table|th|td|tr|form|label|input|select|option|nav|article|section|header|footer)$/;
    exports.checkComponent = function(el, options) {
      var tag = el.tagName.toLowerCase();
      var hasAttrs = el.hasAttributes();
      if (!exports.commonTagRE.test(tag) && tag !== 'component') {
        if (_.resolveAsset(options, 'components', tag)) {
          return {id: tag};
        } else {
          var is = hasAttrs && getIsBinding(el);
          if (is) {
            return is;
          } else if (process.env.NODE_ENV !== 'production') {
            if (tag.indexOf('-') > -1 || (/HTMLUnknownElement/.test(el.toString()) && !/^(data|time|rtc|rb)$/.test(tag))) {
              _.warn('Unknown custom element: <' + tag + '> - did you ' + 'register the component correctly?');
            }
          }
        }
      } else if (hasAttrs) {
        return getIsBinding(el);
      }
    };
    function getIsBinding(el) {
      var exp = _.attr(el, 'is');
      if (exp != null) {
        return {id: exp};
      } else {
        exp = _.getBindAttr(el, 'is');
        if (exp != null) {
          return {
            id: exp,
            dynamic: true
          };
        }
      }
    }
    exports.initProp = function(vm, prop, value) {
      if (exports.assertProp(prop, value)) {
        var key = prop.path;
        vm[key] = vm._data[key] = value;
      }
    };
    exports.assertProp = function(prop, value) {
      if (prop.raw === null && !prop.required) {
        return true;
      }
      var options = prop.options;
      var type = options.type;
      var valid = true;
      var expectedType;
      if (type) {
        if (type === String) {
          expectedType = 'string';
          valid = typeof value === expectedType;
        } else if (type === Number) {
          expectedType = 'number';
          valid = typeof value === 'number';
        } else if (type === Boolean) {
          expectedType = 'boolean';
          valid = typeof value === 'boolean';
        } else if (type === Function) {
          expectedType = 'function';
          valid = typeof value === 'function';
        } else if (type === Object) {
          expectedType = 'object';
          valid = _.isPlainObject(value);
        } else if (type === Array) {
          expectedType = 'array';
          valid = _.isArray(value);
        } else {
          valid = value instanceof type;
        }
      }
      if (!valid) {
        process.env.NODE_ENV !== 'production' && _.warn('Invalid prop: type check failed for ' + prop.path + '="' + prop.raw + '".' + ' Expected ' + formatType(expectedType) + ', got ' + formatValue(value) + '.');
        return false;
      }
      var validator = options.validator;
      if (validator) {
        if (!validator.call(null, value)) {
          process.env.NODE_ENV !== 'production' && _.warn('Invalid prop: custom validator check failed for ' + prop.path + '="' + prop.raw + '"');
          return false;
        }
      }
      return true;
    };
    function formatType(val) {
      return val ? val.charAt(0).toUpperCase() + val.slice(1) : 'custom type';
    }
    function formatValue(val) {
      return Object.prototype.toString.call(val).slice(8, -1);
    }
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("14", ["12", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    if (process.env.NODE_ENV !== 'production') {
      var config = req('12');
      var hasConsole = typeof console !== 'undefined';
      exports.log = function(msg) {
        if (hasConsole && config.debug) {
          console.log('[Vue info]: ' + msg);
        }
      };
      exports.warn = function(msg, e) {
        if (hasConsole && (!config.silent || config.debug)) {
          console.warn('[Vue warn]: ' + msg);
          if (config.debug) {
            console.warn((e || new Error('Warning Stack Trace')).stack);
          }
        }
      };
      exports.assertAsset = function(val, type, id) {
        if (!val) {
          exports.warn('Failed to resolve ' + type + ': ' + id);
        }
      };
    }
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("10", ["8", "9", "3", "4", "2", "14"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var lang = req('8');
  var extend = lang.extend;
  extend(exports, lang);
  extend(exports, req('9'));
  extend(exports, req('3'));
  extend(exports, req('4'));
  extend(exports, req('2'));
  extend(exports, req('14'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("15", ["10"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  module.exports = {
    bind: function() {
      this.attr = this.el.nodeType === 3 ? 'data' : 'textContent';
    },
    update: function(value) {
      this.el[this.attr] = _.toString(value);
    }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("16", ["10", "a"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var Cache = req('a');
  var templateCache = new Cache(1000);
  var idSelectorCache = new Cache(1000);
  var map = {
    _default: [0, '', ''],
    legend: [1, '<fieldset>', '</fieldset>'],
    tr: [2, '<table><tbody>', '</tbody></table>'],
    col: [2, '<table><tbody></tbody><colgroup>', '</colgroup></table>']
  };
  map.td = map.th = [3, '<table><tbody><tr>', '</tr></tbody></table>'];
  map.option = map.optgroup = [1, '<select multiple="multiple">', '</select>'];
  map.thead = map.tbody = map.colgroup = map.caption = map.tfoot = [1, '<table>', '</table>'];
  map.g = map.defs = map.symbol = map.use = map.image = map.text = map.circle = map.ellipse = map.line = map.path = map.polygon = map.polyline = map.rect = [1, '<svg ' + 'xmlns="http://www.w3.org/2000/svg" ' + 'xmlns:xlink="http://www.w3.org/1999/xlink" ' + 'xmlns:ev="http://www.w3.org/2001/xml-events"' + 'version="1.1">', '</svg>'];
  function isRealTemplate(node) {
    return _.isTemplate(node) && node.content instanceof DocumentFragment;
  }
  var tagRE = /<([\w:]+)/;
  var entityRE = /&\w+;|&#\d+;|&#x[\dA-F]+;/;
  function stringToFragment(templateString) {
    var hit = templateCache.get(templateString);
    if (hit) {
      return hit;
    }
    var frag = document.createDocumentFragment();
    var tagMatch = templateString.match(tagRE);
    var entityMatch = entityRE.test(templateString);
    if (!tagMatch && !entityMatch) {
      frag.appendChild(document.createTextNode(templateString));
    } else {
      var tag = tagMatch && tagMatch[1];
      var wrap = map[tag] || map._default;
      var depth = wrap[0];
      var prefix = wrap[1];
      var suffix = wrap[2];
      var node = document.createElement('div');
      node.innerHTML = prefix + templateString.trim() + suffix;
      while (depth--) {
        node = node.lastChild;
      }
      var child;
      while (child = node.firstChild) {
        frag.appendChild(child);
      }
    }
    templateCache.put(templateString, frag);
    return frag;
  }
  function nodeToFragment(node) {
    if (isRealTemplate(node)) {
      _.trimNode(node.content);
      return node.content;
    }
    if (node.tagName === 'SCRIPT') {
      return stringToFragment(node.textContent);
    }
    var clone = exports.clone(node);
    var frag = document.createDocumentFragment();
    var child;
    while (child = clone.firstChild) {
      frag.appendChild(child);
    }
    _.trimNode(frag);
    return frag;
  }
  var hasBrokenTemplate = (function() {
    if (_.inBrowser) {
      var a = document.createElement('div');
      a.innerHTML = '<template>1</template>';
      return !a.cloneNode(true).firstChild.innerHTML;
    } else {
      return false;
    }
  })();
  var hasTextareaCloneBug = (function() {
    if (_.inBrowser) {
      var t = document.createElement('textarea');
      t.placeholder = 't';
      return t.cloneNode(true).value === 't';
    } else {
      return false;
    }
  })();
  exports.clone = function(node) {
    if (!node.querySelectorAll) {
      return node.cloneNode();
    }
    var res = node.cloneNode(true);
    var i,
        original,
        cloned;
    if (hasBrokenTemplate) {
      var clone = res;
      if (isRealTemplate(node)) {
        node = node.content;
        clone = res.content;
      }
      original = node.querySelectorAll('template');
      if (original.length) {
        cloned = clone.querySelectorAll('template');
        i = cloned.length;
        while (i--) {
          cloned[i].parentNode.replaceChild(exports.clone(original[i]), cloned[i]);
        }
      }
    }
    if (hasTextareaCloneBug) {
      if (node.tagName === 'TEXTAREA') {
        res.value = node.value;
      } else {
        original = node.querySelectorAll('textarea');
        if (original.length) {
          cloned = res.querySelectorAll('textarea');
          i = cloned.length;
          while (i--) {
            cloned[i].value = original[i].value;
          }
        }
      }
    }
    return res;
  };
  exports.parse = function(template, clone, noSelector) {
    var node,
        frag;
    if (template instanceof DocumentFragment) {
      _.trimNode(template);
      return clone ? exports.clone(template) : template;
    }
    if (typeof template === 'string') {
      if (!noSelector && template.charAt(0) === '#') {
        frag = idSelectorCache.get(template);
        if (!frag) {
          node = document.getElementById(template.slice(1));
          if (node) {
            frag = nodeToFragment(node);
            idSelectorCache.put(template, frag);
          }
        }
      } else {
        frag = stringToFragment(template);
      }
    } else if (template.nodeType) {
      frag = nodeToFragment(template);
    }
    return frag && clone ? exports.clone(frag) : frag;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("17", ["10", "16"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var templateParser = req('16');
  module.exports = {
    bind: function() {
      if (this.el.nodeType === 8) {
        this.nodes = [];
        this.anchor = _.createAnchor('v-html');
        _.replace(this.el, this.anchor);
      }
    },
    update: function(value) {
      value = _.toString(value);
      if (this.nodes) {
        this.swap(value);
      } else {
        this.el.innerHTML = value;
      }
    },
    swap: function(value) {
      var i = this.nodes.length;
      while (i--) {
        _.remove(this.nodes[i]);
      }
      var frag = templateParser.parse(value, true, true);
      this.nodes = _.toArray(frag.childNodes);
      _.before(frag, this.anchor);
    }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("18", ["10", "13"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var transition = req('13');
  function Fragment(linker, vm, frag, host, scope, parentFrag) {
    this.children = [];
    this.childFrags = [];
    this.vm = vm;
    this.scope = scope;
    this.inserted = false;
    this.parentFrag = parentFrag;
    if (parentFrag) {
      parentFrag.childFrags.push(this);
    }
    this.unlink = linker(vm, frag, host, scope, this);
    var single = this.single = frag.childNodes.length === 1;
    if (single) {
      this.node = frag.childNodes[0];
      this.before = singleBefore;
      this.remove = singleRemove;
    } else {
      this.node = _.createAnchor('fragment-start');
      this.end = _.createAnchor('fragment-end');
      this.frag = frag;
      _.prepend(this.node, frag);
      frag.appendChild(this.end);
      this.before = multiBefore;
      this.remove = multiRemove;
    }
    this.node.__vfrag__ = this;
  }
  Fragment.prototype.callHook = function(hook) {
    var i,
        l;
    for (i = 0, l = this.children.length; i < l; i++) {
      hook(this.children[i]);
    }
    for (i = 0, l = this.childFrags.length; i < l; i++) {
      this.childFrags[i].callHook(hook);
    }
  };
  Fragment.prototype.destroy = function() {
    if (this.parentFrag) {
      this.parentFrag.childFrags.$remove(this);
    }
    this.unlink();
  };
  function singleBefore(target, withTransition) {
    this.inserted = true;
    var method = withTransition !== false ? transition.before : _.before;
    method(this.node, target, this.vm);
    if (_.inDoc(this.node)) {
      this.callHook(attach);
    }
  }
  function singleRemove(destroy) {
    this.inserted = false;
    var shouldCallRemove = _.inDoc(this.node);
    var self = this;
    transition.remove(this.node, this.vm, function() {
      if (shouldCallRemove) {
        self.callHook(detach);
      }
      if (destroy) {
        self.destroy();
      }
    });
  }
  function multiBefore(target, withTransition) {
    this.inserted = true;
    var vm = this.vm;
    var method = withTransition !== false ? transition.before : _.before;
    _.mapNodeRange(this.node, this.end, function(node) {
      method(node, target, vm);
    });
    if (_.inDoc(this.node)) {
      this.callHook(attach);
    }
  }
  function multiRemove(destroy) {
    this.inserted = false;
    var self = this;
    var shouldCallRemove = _.inDoc(this.node);
    _.removeNodeRange(this.node, this.end, this.vm, this.frag, function() {
      if (shouldCallRemove) {
        self.callHook(detach);
      }
      if (destroy) {
        self.destroy();
      }
    });
  }
  function attach(child) {
    if (!child._isAttached) {
      child._callHook('attached');
    }
  }
  function detach(child) {
    if (child._isAttached) {
      child._callHook('detached');
    }
  }
  module.exports = Fragment;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("19", ["10", "1a", "16", "18", "a"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var compiler = req('1a');
  var templateParser = req('16');
  var Fragment = req('18');
  var Cache = req('a');
  var linkerCache = new Cache(5000);
  function FragmentFactory(vm, el) {
    this.vm = vm;
    var template;
    var isString = typeof el === 'string';
    if (isString || _.isTemplate(el)) {
      template = templateParser.parse(el, true);
    } else {
      template = document.createDocumentFragment();
      template.appendChild(el);
    }
    this.template = template;
    var linker;
    var cid = vm.constructor.cid;
    if (cid > 0) {
      var cacheId = cid + (isString ? el : el.outerHTML);
      linker = linkerCache.get(cacheId);
      if (!linker) {
        linker = compiler.compile(template, vm.$options, true);
        linkerCache.put(cacheId, linker);
      }
    } else {
      linker = compiler.compile(template, vm.$options, true);
    }
    this.linker = linker;
  }
  FragmentFactory.prototype.create = function(host, scope, parentFrag) {
    var frag = templateParser.clone(this.template);
    return new Fragment(this.linker, this.vm, frag, host, scope, parentFrag);
  };
  module.exports = FragmentFactory;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1b", ["10", "19", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var FragmentFactory = req('19');
    var isObject = _.isObject;
    var uid = 0;
    module.exports = {
      priority: 2000,
      params: ['track-by', 'stagger', 'enter-stagger', 'leave-stagger'],
      bind: function() {
        var inMatch = this.expression.match(/(.*) in (.*)/);
        if (inMatch) {
          var itMatch = inMatch[1].match(/\((.*),(.*)\)/);
          if (itMatch) {
            this.iterator = itMatch[1].trim();
            this.alias = itMatch[2].trim();
          } else {
            this.alias = inMatch[1].trim();
          }
          this.expression = inMatch[2];
        }
        if (!this.alias) {
          process.env.NODE_ENV !== 'production' && _.warn('Alias is required in v-for.');
          return;
        }
        this.id = '__v-for__' + (++uid);
        var tag = this.el.tagName;
        this.isOption = (tag === 'OPTION' || tag === 'OPTGROUP') && this.el.parentNode.tagName === 'SELECT';
        this.start = _.createAnchor('v-for-start');
        this.end = _.createAnchor('v-for-end');
        _.replace(this.el, this.end);
        _.before(this.start, this.end);
        this.ref = _.findRef(this.el);
        this.cache = Object.create(null);
        this.factory = new FragmentFactory(this.vm, this.el);
      },
      update: function(data) {
        this.diff(data);
        this.updateRef();
        this.updateModel();
      },
      diff: function(data) {
        var item = data[0];
        var convertedFromObject = this.fromObject = isObject(item) && item.hasOwnProperty('$key') && item.hasOwnProperty('$value');
        var trackByKey = this.params.trackBy;
        var oldFrags = this.frags;
        var frags = this.frags = new Array(data.length);
        var alias = this.alias;
        var iterator = this.iterator;
        var start = this.start;
        var end = this.end;
        var inDoc = _.inDoc(start);
        var init = !oldFrags;
        var i,
            l,
            frag,
            key,
            value,
            primitive;
        for (i = 0, l = data.length; i < l; i++) {
          item = data[i];
          key = convertedFromObject ? item.$key : null;
          value = convertedFromObject ? item.$value : item;
          primitive = !isObject(value);
          frag = !init && this.getCachedFrag(value, i, key);
          if (frag) {
            frag.reused = true;
            frag.scope.$index = i;
            if (key) {
              frag.scope.$key = key;
              if (iterator) {
                frag.scope[iterator] = key;
              }
            }
            if (trackByKey || convertedFromObject || primitive) {
              frag.scope[alias] = value;
            }
          } else {
            frag = this.create(value, alias, i, key);
            frag.fresh = !init;
          }
          frags[i] = frag;
          if (init) {
            frag.before(end);
          }
        }
        if (init) {
          return;
        }
        var removalIndex = 0;
        var totalRemoved = oldFrags.length - frags.length;
        for (i = 0, l = oldFrags.length; i < l; i++) {
          frag = oldFrags[i];
          if (!frag.reused) {
            this.deleteCachedFrag(frag);
            this.remove(frag, removalIndex++, totalRemoved, inDoc);
          }
        }
        var targetPrev,
            prevEl,
            currentPrev;
        var insertionIndex = 0;
        for (i = 0, l = frags.length; i < l; i++) {
          frag = frags[i];
          targetPrev = frags[i - 1];
          prevEl = targetPrev ? targetPrev.staggerCb ? targetPrev.staggerAnchor : targetPrev.end || targetPrev.node : start;
          if (frag.reused && !frag.staggerCb) {
            currentPrev = findPrevFrag(frag, start, this.id);
            if (currentPrev !== targetPrev) {
              this.move(frag, prevEl);
            }
          } else {
            this.insert(frag, insertionIndex++, prevEl, inDoc);
          }
          frag.reused = frag.fresh = false;
        }
      },
      create: function(value, alias, index, key) {
        var host = this._host;
        var parentScope = this._scope || this.vm;
        var scope = Object.create(parentScope);
        scope.$refs = {};
        scope.$els = {};
        scope.$parent = parentScope;
        scope.$forContext = this;
        _.defineReactive(scope, alias, value);
        _.defineReactive(scope, '$index', index);
        if (key) {
          _.defineReactive(scope, '$key', key);
        } else if (scope.$key) {
          _.define(scope, '$key', null);
        }
        if (this.iterator) {
          _.defineReactive(scope, this.iterator, key || index);
        }
        var frag = this.factory.create(host, scope, this._frag);
        frag.forId = this.id;
        this.cacheFrag(value, frag, index, key);
        return frag;
      },
      updateRef: function() {
        var ref = this.ref;
        if (!ref)
          return;
        var hash = (this._scope || this.vm).$refs;
        var refs;
        if (!this.fromObject) {
          refs = this.frags.map(findVmFromFrag);
        } else {
          refs = {};
          this.frags.forEach(function(frag) {
            refs[frag.scope.$key] = findVmFromFrag(frag);
          });
        }
        if (!hash.hasOwnProperty(ref)) {
          _.defineReactive(hash, ref, refs);
        } else {
          hash[ref] = refs;
        }
      },
      updateModel: function() {
        if (this.isOption) {
          var parent = this.start.parentNode;
          var model = parent && parent.__v_model;
          if (model) {
            model.forceUpdate();
          }
        }
      },
      insert: function(frag, index, prevEl, inDoc) {
        if (frag.staggerCb) {
          frag.staggerCb.cancel();
          frag.staggerCb = null;
        }
        var staggerAmount = this.getStagger(frag, index, null, 'enter');
        if (inDoc && staggerAmount) {
          var anchor = frag.staggerAnchor;
          if (!anchor) {
            anchor = frag.staggerAnchor = _.createAnchor('stagger-anchor');
            anchor.__vfrag__ = frag;
          }
          _.after(anchor, prevEl);
          var op = frag.staggerCb = _.cancellable(function() {
            frag.staggerCb = null;
            frag.before(anchor);
            _.remove(anchor);
          });
          setTimeout(op, staggerAmount);
        } else {
          frag.before(prevEl.nextSibling);
        }
      },
      remove: function(frag, index, total, inDoc) {
        if (frag.staggerCb) {
          frag.staggerCb.cancel();
          frag.staggerCb = null;
          return;
        }
        var staggerAmount = this.getStagger(frag, index, total, 'leave');
        if (inDoc && staggerAmount) {
          var op = frag.staggerCb = _.cancellable(function() {
            frag.staggerCb = null;
            frag.remove(true);
          });
          setTimeout(op, staggerAmount);
        } else {
          frag.remove(true);
        }
      },
      move: function(frag, prevEl) {
        frag.before(prevEl.nextSibling, false);
      },
      cacheFrag: function(value, frag, index, key) {
        var trackByKey = this.params.trackBy;
        var cache = this.cache;
        var primitive = !isObject(value);
        var id;
        if (key || trackByKey || primitive) {
          id = trackByKey ? trackByKey === '$index' ? index : value[trackByKey] : (key || value);
          if (!cache[id]) {
            cache[id] = frag;
          } else if (trackByKey !== '$index') {
            process.env.NODE_ENV !== 'production' && this.warnDuplicate(value);
          }
        } else {
          id = this.id;
          if (value.hasOwnProperty(id)) {
            if (value[id] === null) {
              value[id] = frag;
            } else {
              process.env.NODE_ENV !== 'production' && this.warnDuplicate(value);
            }
          } else {
            _.define(value, id, frag);
          }
        }
        frag.raw = value;
      },
      getCachedFrag: function(value, index, key) {
        var trackByKey = this.params.trackBy;
        var primitive = !isObject(value);
        var frag;
        if (key || trackByKey || primitive) {
          var id = trackByKey ? trackByKey === '$index' ? index : value[trackByKey] : (key || value);
          frag = this.cache[id];
        } else {
          frag = value[this.id];
        }
        if (frag && (frag.reused || frag.fresh)) {
          process.env.NODE_ENV !== 'production' && this.warnDuplicate(value);
        }
        return frag;
      },
      deleteCachedFrag: function(frag) {
        var value = frag.raw;
        var trackByKey = this.params.trackBy;
        var scope = frag.scope;
        var index = scope.$index;
        var key = scope.hasOwnProperty('$key') && scope.$key;
        var primitive = !isObject(value);
        if (trackByKey || key || primitive) {
          var id = trackByKey ? trackByKey === '$index' ? index : value[trackByKey] : (key || value);
          this.cache[id] = null;
        } else {
          value[this.id] = null;
          frag.raw = null;
        }
      },
      getStagger: function(frag, index, total, type) {
        type = type + 'Stagger';
        var trans = frag.node.__v_trans;
        var hooks = trans && trans.hooks;
        var hook = hooks && (hooks[type] || hooks.stagger);
        return hook ? hook.call(frag, index, total) : index * parseInt(this.params[type] || this.params.stagger, 10);
      },
      _preProcess: function(value) {
        this.rawValue = value;
        return value;
      },
      _postProcess: function(value) {
        if (_.isArray(value)) {
          return value;
        } else if (_.isPlainObject(value)) {
          var keys = Object.keys(value);
          var i = keys.length;
          var res = new Array(i);
          var key;
          while (i--) {
            key = keys[i];
            res[i] = {
              $key: key,
              $value: value[key]
            };
          }
          return res;
        } else {
          var type = typeof value;
          if (type === 'number') {
            value = range(value);
          } else if (type === 'string') {
            value = _.toArray(value);
          }
          return value || [];
        }
      },
      unbind: function() {
        if (this.ref) {
          (this._scope || this.vm).$refs[this.ref] = null;
        }
        if (this.frags) {
          var i = this.frags.length;
          var frag;
          while (i--) {
            frag = this.frags[i];
            this.deleteCachedFrag(frag);
            frag.destroy();
          }
        }
      }
    };
    function findPrevFrag(frag, anchor, id) {
      var el = frag.node.previousSibling;
      if (!el)
        return;
      frag = el.__vfrag__;
      while ((!frag || frag.forId !== id || !frag.inserted) && el !== anchor) {
        el = el.previousSibling;
        if (!el)
          return;
        frag = el.__vfrag__;
      }
      return frag;
    }
    function findVmFromFrag(frag) {
      return frag.node.__vue__ || frag.node.nextSibling.__vue__;
    }
    function range(n) {
      var i = -1;
      var ret = new Array(n);
      while (++i < n) {
        ret[i] = i;
      }
      return ret;
    }
    if (process.env.NODE_ENV !== 'production') {
      module.exports.warnDuplicate = function(value) {
        _.warn('Duplicate value found in v-for="' + this.descriptor.raw + '": ' + JSON.stringify(value) + '. Use track-by="$index" if ' + 'you are expecting duplicate values.');
      };
    }
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1c", ["10", "19", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var FragmentFactory = req('19');
    module.exports = {
      priority: 2000,
      bind: function() {
        var el = this.el;
        if (!el.__vue__) {
          var next = el.nextElementSibling;
          if (next && _.attr(next, 'v-else') !== null) {
            _.remove(next);
            this.elseFactory = new FragmentFactory(this.vm, next);
          }
          this.anchor = _.createAnchor('v-if');
          _.replace(el, this.anchor);
          this.factory = new FragmentFactory(this.vm, el);
        } else {
          process.env.NODE_ENV !== 'production' && _.warn('v-if="' + this.expression + '" cannot be ' + 'used on an instance root element.');
          this.invalid = true;
        }
      },
      update: function(value) {
        if (this.invalid)
          return;
        if (value) {
          if (!this.frag) {
            this.insert();
          }
        } else {
          this.remove();
        }
      },
      insert: function() {
        if (this.elseFrag) {
          this.elseFrag.remove(true);
          this.elseFrag = null;
        }
        this.frag = this.factory.create(this._host, this._scope, this._frag);
        this.frag.before(this.anchor);
      },
      remove: function() {
        if (this.frag) {
          this.frag.remove(true);
          this.frag = null;
        }
        if (this.elseFactory) {
          this.elseFrag = this.elseFactory.create(this._host, this._scope, this._frag);
          this.elseFrag.before(this.anchor);
        }
      },
      unbind: function() {
        if (this.frag) {
          this.frag.destroy();
        }
      }
    };
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1d", ["10", "13"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var transition = req('13');
  module.exports = {
    bind: function() {
      var next = this.el.nextElementSibling;
      if (next && _.attr(next, 'v-else') !== null) {
        this.elseEl = next;
      }
    },
    update: function(value) {
      var el = this.el;
      transition.apply(el, value ? 1 : -1, function() {
        el.style.display = value ? '' : 'none';
      }, this.vm);
      var elseEl = this.elseEl;
      if (elseEl) {
        transition.apply(elseEl, value ? -1 : 1, function() {
          elseEl.style.display = value ? 'none' : '';
        }, this.vm);
      }
    }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1e", ["10"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  module.exports = {
    bind: function() {
      var self = this;
      var el = this.el;
      var isRange = el.type === 'range';
      var lazy = this.params.lazy;
      var number = this.params.number;
      var debounce = this.params.debounce;
      var composing = false;
      if (!_.isAndroid && !isRange) {
        this.on('compositionstart', function() {
          composing = true;
        });
        this.on('compositionend', function() {
          composing = false;
          if (!lazy) {
            self.listener();
          }
        });
      }
      this.focused = false;
      if (!isRange) {
        this.on('focus', function() {
          self.focused = true;
        });
        this.on('blur', function() {
          self.focused = false;
          self.listener();
        });
      }
      this.listener = function() {
        if (composing)
          return;
        var val = number || isRange ? _.toNumber(el.value) : el.value;
        self.set(val);
        _.nextTick(function() {
          if (self._bound && !self.focused) {
            self.update(self._watcher.value);
          }
        });
      };
      if (debounce) {
        this.listener = _.debounce(this.listener, debounce);
      }
      this.hasjQuery = typeof jQuery === 'function';
      if (this.hasjQuery) {
        jQuery(el).on('change', this.listener);
        if (!lazy) {
          jQuery(el).on('input', this.listener);
        }
      } else {
        this.on('change', this.listener);
        if (!lazy) {
          this.on('input', this.listener);
        }
      }
      if (!lazy && _.isIE9) {
        this.on('cut', function() {
          _.nextTick(self.listener);
        });
        this.on('keyup', function(e) {
          if (e.keyCode === 46 || e.keyCode === 8) {
            self.listener();
          }
        });
      }
      if (el.hasAttribute('value') || (el.tagName === 'TEXTAREA' && el.value.trim())) {
        this.afterBind = this.listener;
      }
    },
    update: function(value) {
      this.el.value = _.toString(value);
    },
    unbind: function() {
      var el = this.el;
      if (this.hasjQuery) {
        jQuery(el).off('change', this.listener);
        jQuery(el).off('input', this.listener);
      }
    }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1f", ["10"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  module.exports = {
    bind: function() {
      var self = this;
      var el = this.el;
      this.getValue = function() {
        if (el.hasOwnProperty('_value')) {
          return el._value;
        }
        var val = el.value;
        if (self.params.number) {
          val = _.toNumber(val);
        }
        return val;
      };
      this.listener = function() {
        self.set(self.getValue());
      };
      this.on('change', this.listener);
      if (el.checked) {
        this.afterBind = this.listener;
      }
    },
    update: function(value) {
      this.el.checked = _.looseEqual(value, this.getValue());
    }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("20", ["10"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  module.exports = {
    bind: function() {
      var self = this;
      var el = this.el;
      this.forceUpdate = function() {
        if (self._watcher) {
          self.update(self._watcher.get());
        }
      };
      var multiple = this.multiple = el.hasAttribute('multiple');
      this.listener = function() {
        var value = getValue(el, multiple);
        value = self.params.number ? _.isArray(value) ? value.map(_.toNumber) : _.toNumber(value) : value;
        self.set(value);
      };
      this.on('change', this.listener);
      var initValue = getValue(el, multiple, true);
      if ((multiple && initValue.length) || (!multiple && initValue !== null)) {
        this.afterBind = this.listener;
      }
      this.vm.$on('hook:attached', this.forceUpdate);
    },
    update: function(value) {
      var el = this.el;
      el.selectedIndex = -1;
      var multi = this.multiple && _.isArray(value);
      var options = el.options;
      var i = options.length;
      var op,
          val;
      while (i--) {
        op = options[i];
        val = op.hasOwnProperty('_value') ? op._value : op.value;
        op.selected = multi ? indexOf(value, val) > -1 : _.looseEqual(value, val);
      }
    },
    unbind: function() {
      this.vm.$off('hook:attached', this.forceUpdate);
    }
  };
  function getValue(el, multi, init) {
    var res = multi ? [] : null;
    var op,
        val,
        selected;
    for (var i = 0,
        l = el.options.length; i < l; i++) {
      op = el.options[i];
      selected = init ? op.hasAttribute('selected') : op.selected;
      if (selected) {
        val = op.hasOwnProperty('_value') ? op._value : op.value;
        if (multi) {
          res.push(val);
        } else {
          return val;
        }
      }
    }
    return res;
  }
  function indexOf(arr, val) {
    var i = arr.length;
    while (i--) {
      if (_.looseEqual(arr[i], val)) {
        return i;
      }
    }
    return -1;
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("21", ["10"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  module.exports = {
    bind: function() {
      var self = this;
      var el = this.el;
      this.getValue = function() {
        return el.hasOwnProperty('_value') ? el._value : self.params.number ? _.toNumber(el.value) : el.value;
      };
      function getBooleanValue() {
        var val = el.checked;
        if (val && el.hasOwnProperty('_trueValue')) {
          return el._trueValue;
        }
        if (!val && el.hasOwnProperty('_falseValue')) {
          return el._falseValue;
        }
        return val;
      }
      this.listener = function() {
        var model = self._watcher.value;
        if (_.isArray(model)) {
          var val = self.getValue();
          if (el.checked) {
            if (_.indexOf(model, val) < 0) {
              model.push(val);
            }
          } else {
            model.$remove(val);
          }
        } else {
          self.set(getBooleanValue());
        }
      };
      this.on('change', this.listener);
      if (el.checked) {
        this.afterBind = this.listener;
      }
    },
    update: function(value) {
      var el = this.el;
      if (_.isArray(value)) {
        el.checked = _.indexOf(value, this.getValue()) > -1;
      } else {
        if (el.hasOwnProperty('_trueValue')) {
          el.checked = _.looseEqual(value, el._trueValue);
        } else {
          el.checked = !!value;
        }
      }
    }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("22", ["10", "1e", "1f", "20", "21", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var handlers = {
      text: req('1e'),
      radio: req('1f'),
      select: req('20'),
      checkbox: req('21')
    };
    module.exports = {
      priority: 800,
      twoWay: true,
      handlers: handlers,
      params: ['lazy', 'number', 'debounce'],
      bind: function() {
        this.checkFilters();
        if (this.hasRead && !this.hasWrite) {
          process.env.NODE_ENV !== 'production' && _.warn('It seems you are using a read-only filter with ' + 'v-model. You might want to use a two-way filter ' + 'to ensure correct behavior.');
        }
        var el = this.el;
        var tag = el.tagName;
        var handler;
        if (tag === 'INPUT') {
          handler = handlers[el.type] || handlers.text;
        } else if (tag === 'SELECT') {
          handler = handlers.select;
        } else if (tag === 'TEXTAREA') {
          handler = handlers.text;
        } else {
          process.env.NODE_ENV !== 'production' && _.warn('v-model does not support element type: ' + tag);
          return;
        }
        el.__v_model = this;
        handler.bind.call(this);
        this.update = handler.update;
        this._unbind = handler.unbind;
      },
      checkFilters: function() {
        var filters = this.filters;
        if (!filters)
          return;
        var i = filters.length;
        while (i--) {
          var filter = _.resolveAsset(this.vm.$options, 'filters', filters[i].name);
          if (typeof filter === 'function' || filter.read) {
            this.hasRead = true;
          }
          if (filter.write) {
            this.hasWrite = true;
          }
        }
      },
      unbind: function() {
        this.el.__v_model = null;
        this._unbind && this._unbind();
      }
    };
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("23", ["10", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var keyCodes = {
      esc: 27,
      tab: 9,
      enter: 13,
      space: 32,
      'delete': 46,
      up: 38,
      left: 37,
      right: 39,
      down: 40
    };
    function keyFilter(handler, keys) {
      var codes = keys.map(function(key) {
        var code = keyCodes[key];
        if (!code) {
          code = parseInt(key, 10);
        }
        return code;
      });
      return function keyHandler(e) {
        if (codes.indexOf(e.keyCode) > -1) {
          return handler.call(this, e);
        }
      };
    }
    function stopFilter(handler) {
      return function stopHandler(e) {
        e.stopPropagation();
        return handler.call(this, e);
      };
    }
    function preventFilter(handler) {
      return function preventHandler(e) {
        e.preventDefault();
        return handler.call(this, e);
      };
    }
    module.exports = {
      acceptStatement: true,
      priority: 700,
      bind: function() {
        if (this.el.tagName === 'IFRAME' && this.arg !== 'load') {
          var self = this;
          this.iframeBind = function() {
            _.on(self.el.contentWindow, self.arg, self.handler);
          };
          this.on('load', this.iframeBind);
        }
      },
      update: function(handler) {
        if (!this.descriptor.raw) {
          handler = function() {};
        }
        if (typeof handler !== 'function') {
          process.env.NODE_ENV !== 'production' && _.warn('v-on:' + this.arg + '="' + this.expression + '" expects a function value, ' + 'got ' + handler);
          return;
        }
        if (this.modifiers.stop) {
          handler = stopFilter(handler);
        }
        if (this.modifiers.prevent) {
          handler = preventFilter(handler);
        }
        var keys = Object.keys(this.modifiers).filter(function(key) {
          return key !== 'stop' && key !== 'prevent';
        });
        if (keys.length) {
          handler = keyFilter(handler, keys);
        }
        this.reset();
        var scope = this._scope || this.vm;
        this.handler = function(e) {
          scope.$event = e;
          var res = handler(e);
          scope.$event = null;
          return res;
        };
        if (this.iframeBind) {
          this.iframeBind();
        } else {
          _.on(this.el, this.arg, this.handler);
        }
      },
      reset: function() {
        var el = this.iframeBind ? this.el.contentWindow : this.el;
        if (this.handler) {
          _.off(el, this.arg, this.handler);
        }
      },
      unbind: function() {
        this.reset();
      }
    };
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("24", ["10", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var xlinkNS = 'http://www.w3.org/1999/xlink';
    var xlinkRE = /^xlink:/;
    var inputProps = {
      value: 1,
      checked: 1,
      selected: 1
    };
    var modelProps = {
      value: '_value',
      'true-value': '_trueValue',
      'false-value': '_falseValue'
    };
    var disallowedInterpAttrRE = /^v-|^:|^@|^(is|transition|transition-mode|debounce|track-by|stagger|enter-stagger|leave-stagger)$/;
    module.exports = {
      priority: 850,
      bind: function() {
        var attr = this.arg;
        var tag = this.el.tagName;
        if (this.descriptor.interp) {
          if (disallowedInterpAttrRE.test(attr) || (attr === 'name' && (tag === 'PARTIAL' || tag === 'SLOT'))) {
            process.env.NODE_ENV !== 'production' && _.warn(attr + '="' + this.descriptor.raw + '": ' + 'attribute interpolation is not allowed in Vue.js ' + 'directives and special attributes.');
            this.el.removeAttribute(attr);
            this.invalid = true;
          }
          if (process.env.NODE_ENV !== 'production') {
            var raw = attr + '="' + this.descriptor.raw + '": ';
            if (attr === 'src') {
              _.warn(raw + 'interpolation in "src" attribute will cause ' + 'a 404 request. Use v-bind:src instead.');
            }
            if (attr === 'style') {
              _.warn(raw + 'interpolation in "style" attribtue will cause ' + 'the attribtue to be discarded in Internet Explorer. ' + 'Use v-bind:style instead.');
            }
          }
        }
      },
      update: function(value) {
        if (this.invalid) {
          return;
        }
        var attr = this.arg;
        if (inputProps[attr] && attr in this.el) {
          this.el[attr] = value;
        }
        var modelProp = modelProps[attr];
        if (modelProp) {
          this.el[modelProp] = value;
          var model = this.el.__v_model;
          if (model) {
            model.listener();
          }
        }
        if (attr === 'value' && this.el.tagName === 'TEXTAREA') {
          this.el.removeAttribute(attr);
          return;
        }
        if (value != null && value !== false) {
          if (xlinkRE.test(attr)) {
            this.el.setAttributeNS(xlinkNS, attr, value);
          } else {
            this.el.setAttribute(attr, value);
          }
        } else {
          this.el.removeAttribute(attr);
        }
      }
    };
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("25", ["10"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  module.exports = {
    priority: 1500,
    bind: function() {
      if (!this.arg) {
        return;
      }
      var id = this.id = _.camelize(this.arg);
      var refs = (this._scope || this.vm).$els;
      if (refs.hasOwnProperty(id)) {
        refs[id] = this.el;
      } else {
        _.defineReactive(refs, id, this.el);
      }
    },
    unbind: function() {
      var refs = (this._scope || this.vm).$els;
      if (refs[this.id] === this.el) {
        refs[this.id] = null;
      }
    }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("26", ["10", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    if (process.env.NODE_ENV !== 'production') {
      module.exports = {bind: function() {
          req('10').warn('v-ref:' + this.arg + ' must be used on a child ' + 'component. Found on <' + this.el.tagName.toLowerCase() + '>.');
        }};
    }
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("27", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {bind: function() {
      var el = this.el;
      this.vm.$once('hook:compiled', function() {
        el.removeAttribute('v-cloak');
      });
    }};
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("28", ["15", "17", "1b", "1c", "1d", "22", "23", "24", "25", "26", "27"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  exports.text = req('15');
  exports.html = req('17');
  exports['for'] = req('1b');
  exports['if'] = req('1c');
  exports.show = req('1d');
  exports.model = req('22');
  exports.on = req('23');
  exports.bind = req('24');
  exports.el = req('25');
  exports.ref = req('26');
  exports.cloak = req('27');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("29", ["10"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var prefixes = ['-webkit-', '-moz-', '-ms-'];
  var camelPrefixes = ['Webkit', 'Moz', 'ms'];
  var importantRE = /!important;?$/;
  var camelRE = /([a-z])([A-Z])/g;
  var testEl = null;
  var propCache = {};
  module.exports = {
    deep: true,
    update: function(value) {
      if (typeof value === 'string') {
        this.el.style.cssText = value;
      } else if (_.isArray(value)) {
        this.objectHandler(value.reduce(_.extend, {}));
      } else {
        this.objectHandler(value);
      }
    },
    objectHandler: function(value) {
      var cache = this.cache || (this.cache = {});
      var prop,
          val;
      for (prop in cache) {
        if (!(prop in value)) {
          this.setProp(prop, null);
          delete cache[prop];
        }
      }
      for (prop in value) {
        val = value[prop];
        if (val !== cache[prop]) {
          cache[prop] = val;
          this.setProp(prop, val);
        }
      }
    },
    setProp: function(prop, value) {
      prop = normalize(prop);
      if (!prop)
        return;
      if (value != null)
        value += '';
      if (value) {
        var isImportant = importantRE.test(value) ? 'important' : '';
        if (isImportant) {
          value = value.replace(importantRE, '').trim();
        }
        this.el.style.setProperty(prop, value, isImportant);
      } else {
        this.el.style.removeProperty(prop);
      }
    }
  };
  function normalize(prop) {
    if (propCache[prop]) {
      return propCache[prop];
    }
    var res = prefix(prop);
    propCache[prop] = propCache[res] = res;
    return res;
  }
  function prefix(prop) {
    prop = prop.replace(camelRE, '$1-$2').toLowerCase();
    var camel = _.camelize(prop);
    var upper = camel.charAt(0).toUpperCase() + camel.slice(1);
    if (!testEl) {
      testEl = document.createElement('div');
    }
    if (camel in testEl.style) {
      return prop;
    }
    var i = prefixes.length;
    var prefixed;
    while (i--) {
      prefixed = camelPrefixes[i] + upper;
      if (prefixed in testEl.style) {
        return prefixes[i] + prop;
      }
    }
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2a", ["10"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var addClass = _.addClass;
  var removeClass = _.removeClass;
  module.exports = {
    update: function(value) {
      if (value && typeof value === 'string') {
        this.handleObject(stringToObject(value));
      } else if (_.isPlainObject(value)) {
        this.handleObject(value);
      } else if (_.isArray(value)) {
        this.handleArray(value);
      } else {
        this.cleanup();
      }
    },
    handleObject: function(value) {
      this.cleanup(value);
      var keys = this.prevKeys = Object.keys(value);
      for (var i = 0,
          l = keys.length; i < l; i++) {
        var key = keys[i];
        if (value[key]) {
          addClass(this.el, key);
        } else {
          removeClass(this.el, key);
        }
      }
    },
    handleArray: function(value) {
      this.cleanup(value);
      for (var i = 0,
          l = value.length; i < l; i++) {
        if (value[i]) {
          addClass(this.el, value[i]);
        }
      }
      this.prevKeys = value.slice();
    },
    cleanup: function(value) {
      if (this.prevKeys) {
        var i = this.prevKeys.length;
        while (i--) {
          var key = this.prevKeys[i];
          if (key && (!value || !contains(value, key))) {
            removeClass(this.el, key);
          }
        }
      }
    }
  };
  function stringToObject(value) {
    var res = {};
    var keys = value.trim().split(/\s+/);
    var i = keys.length;
    while (i--) {
      res[keys[i]] = true;
    }
    return res;
  }
  function contains(value, key) {
    return _.isArray(value) ? value.indexOf(key) > -1 : value.hasOwnProperty(key);
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2b", ["10", "16", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var templateParser = req('16');
    module.exports = {
      priority: 1500,
      params: ['keep-alive', 'transition-mode', 'inline-template'],
      bind: function() {
        if (!this.el.__vue__) {
          this.ref = _.findRef(this.el);
          var refs = (this._scope || this.vm).$refs;
          if (this.ref && !refs.hasOwnProperty(this.ref)) {
            _.defineReactive(refs, this.ref, null);
          }
          this.keepAlive = this.params.keepAlive;
          if (this.keepAlive) {
            this.cache = {};
          }
          if (this.params.inlineTemplate) {
            this.inlineTemplate = _.extractContent(this.el, true);
          }
          this.pendingComponentCb = this.Component = null;
          this.pendingRemovals = 0;
          this.pendingRemovalCb = null;
          this.anchor = _.createAnchor('v-component');
          _.replace(this.el, this.anchor);
          if (this.literal) {
            this.setComponent(this.expression);
          }
        } else {
          process.env.NODE_ENV !== 'production' && _.warn('cannot mount component "' + this.expression + '" ' + 'on already mounted element: ' + this.el);
        }
      },
      update: function(value) {
        if (!this.literal) {
          this.setComponent(value);
        }
      },
      setComponent: function(value, cb) {
        this.invalidatePending();
        if (!value) {
          this.unbuild(true);
          this.remove(this.childVM, cb);
          this.childVM = null;
        } else {
          var self = this;
          this.resolveComponent(value, function() {
            self.mountComponent(cb);
          });
        }
      },
      resolveComponent: function(id, cb) {
        var self = this;
        this.pendingComponentCb = _.cancellable(function(Component) {
          self.Component = Component;
          cb();
        });
        this.vm._resolveComponent(id, this.pendingComponentCb);
      },
      mountComponent: function(cb) {
        this.unbuild(true);
        var self = this;
        var activateHook = this.Component.options.activate;
        var cached = this.getCached();
        var newComponent = this.build();
        if (activateHook && !cached) {
          this.waitingFor = newComponent;
          activateHook.call(newComponent, function() {
            self.waitingFor = null;
            self.transition(newComponent, cb);
          });
        } else {
          this.transition(newComponent, cb);
        }
      },
      invalidatePending: function() {
        if (this.pendingComponentCb) {
          this.pendingComponentCb.cancel();
          this.pendingComponentCb = null;
        }
      },
      build: function(extraOptions) {
        var cached = this.getCached();
        if (cached) {
          return cached;
        }
        if (this.Component) {
          var options = {
            el: templateParser.clone(this.el),
            template: this.inlineTemplate,
            parent: this._host || this.vm,
            _linkerCachable: !this.inlineTemplate,
            _ref: this.ref,
            _asComponent: true,
            _isRouterView: this._isRouterView,
            _context: this.vm,
            _scope: this._scope,
            _frag: this._frag
          };
          if (extraOptions) {
            _.extend(options, extraOptions);
          }
          var child = new this.Component(options);
          if (this.keepAlive) {
            this.cache[this.Component.cid] = child;
          }
          if (process.env.NODE_ENV !== 'production' && this.el.hasAttribute('transition') && child._isFragment) {
            _.warn('Transitions will not work on a fragment instance. ' + 'Template: ' + child.$options.template);
          }
          return child;
        }
      },
      getCached: function() {
        return this.keepAlive && this.cache[this.Component.cid];
      },
      unbuild: function(defer) {
        if (this.waitingFor) {
          this.waitingFor.$destroy();
          this.waitingFor = null;
        }
        var child = this.childVM;
        if (!child || this.keepAlive) {
          return;
        }
        child.$destroy(false, defer);
      },
      remove: function(child, cb) {
        var keepAlive = this.keepAlive;
        if (child) {
          this.pendingRemovals++;
          this.pendingRemovalCb = cb;
          var self = this;
          child.$remove(function() {
            self.pendingRemovals--;
            if (!keepAlive)
              child._cleanup();
            if (!self.pendingRemovals && self.pendingRemovalCb) {
              self.pendingRemovalCb();
              self.pendingRemovalCb = null;
            }
          });
        } else if (cb) {
          cb();
        }
      },
      transition: function(target, cb) {
        var self = this;
        var current = this.childVM;
        this.childVM = target;
        switch (self.params.transitionMode) {
          case 'in-out':
            target.$before(self.anchor, function() {
              self.remove(current, cb);
            });
            break;
          case 'out-in':
            self.remove(current, function() {
              target.$before(self.anchor, cb);
            });
            break;
          default:
            self.remove(current);
            target.$before(self.anchor, cb);
        }
      },
      unbind: function() {
        this.invalidatePending();
        this.unbuild();
        if (this.cache) {
          for (var key in this.cache) {
            this.cache[key].$destroy();
          }
          this.cache = null;
        }
      }
    };
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2c", ["10"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var uid = 0;
  function Dep() {
    this.id = uid++;
    this.subs = [];
  }
  Dep.target = null;
  Dep.prototype.addSub = function(sub) {
    this.subs.push(sub);
  };
  Dep.prototype.removeSub = function(sub) {
    this.subs.$remove(sub);
  };
  Dep.prototype.depend = function() {
    Dep.target.addDep(this);
  };
  Dep.prototype.notify = function() {
    var subs = _.toArray(this.subs);
    for (var i = 0,
        l = subs.length; i < l; i++) {
      subs[i].update();
    }
  };
  module.exports = Dep;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2d", ["10", "a", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var Cache = req('a');
    var pathCache = new Cache(1000);
    var identRE = exports.identRE = /^[$_a-zA-Z]+[\w$]*$/;
    var APPEND = 0;
    var PUSH = 1;
    var BEFORE_PATH = 0;
    var IN_PATH = 1;
    var BEFORE_IDENT = 2;
    var IN_IDENT = 3;
    var BEFORE_ELEMENT = 4;
    var AFTER_ZERO = 5;
    var IN_INDEX = 6;
    var IN_SINGLE_QUOTE = 7;
    var IN_DOUBLE_QUOTE = 8;
    var IN_SUB_PATH = 9;
    var AFTER_ELEMENT = 10;
    var AFTER_PATH = 11;
    var ERROR = 12;
    var pathStateMachine = [];
    pathStateMachine[BEFORE_PATH] = {
      'ws': [BEFORE_PATH],
      'ident': [IN_IDENT, APPEND],
      '[': [BEFORE_ELEMENT],
      'eof': [AFTER_PATH]
    };
    pathStateMachine[IN_PATH] = {
      'ws': [IN_PATH],
      '.': [BEFORE_IDENT],
      '[': [BEFORE_ELEMENT],
      'eof': [AFTER_PATH]
    };
    pathStateMachine[BEFORE_IDENT] = {
      'ws': [BEFORE_IDENT],
      'ident': [IN_IDENT, APPEND]
    };
    pathStateMachine[IN_IDENT] = {
      'ident': [IN_IDENT, APPEND],
      '0': [IN_IDENT, APPEND],
      'number': [IN_IDENT, APPEND],
      'ws': [IN_PATH, PUSH],
      '.': [BEFORE_IDENT, PUSH],
      '[': [BEFORE_ELEMENT, PUSH],
      'eof': [AFTER_PATH, PUSH]
    };
    pathStateMachine[BEFORE_ELEMENT] = {
      'ws': [BEFORE_ELEMENT],
      '0': [AFTER_ZERO, APPEND],
      'number': [IN_INDEX, APPEND],
      "'": [IN_SINGLE_QUOTE, APPEND, ''],
      '"': [IN_DOUBLE_QUOTE, APPEND, ''],
      'ident': [IN_SUB_PATH, APPEND, '*']
    };
    pathStateMachine[AFTER_ZERO] = {
      'ws': [AFTER_ELEMENT, PUSH],
      ']': [IN_PATH, PUSH]
    };
    pathStateMachine[IN_INDEX] = {
      '0': [IN_INDEX, APPEND],
      'number': [IN_INDEX, APPEND],
      'ws': [AFTER_ELEMENT],
      ']': [IN_PATH, PUSH]
    };
    pathStateMachine[IN_SINGLE_QUOTE] = {
      "'": [AFTER_ELEMENT],
      'eof': ERROR,
      'else': [IN_SINGLE_QUOTE, APPEND]
    };
    pathStateMachine[IN_DOUBLE_QUOTE] = {
      '"': [AFTER_ELEMENT],
      'eof': ERROR,
      'else': [IN_DOUBLE_QUOTE, APPEND]
    };
    pathStateMachine[IN_SUB_PATH] = {
      'ident': [IN_SUB_PATH, APPEND],
      '0': [IN_SUB_PATH, APPEND],
      'number': [IN_SUB_PATH, APPEND],
      'ws': [AFTER_ELEMENT],
      ']': [IN_PATH, PUSH]
    };
    pathStateMachine[AFTER_ELEMENT] = {
      'ws': [AFTER_ELEMENT],
      ']': [IN_PATH, PUSH]
    };
    function getPathCharType(ch) {
      if (ch === undefined) {
        return 'eof';
      }
      var code = ch.charCodeAt(0);
      switch (code) {
        case 0x5B:
        case 0x5D:
        case 0x2E:
        case 0x22:
        case 0x27:
        case 0x30:
          return ch;
        case 0x5F:
        case 0x24:
          return 'ident';
        case 0x20:
        case 0x09:
        case 0x0A:
        case 0x0D:
        case 0xA0:
        case 0xFEFF:
        case 0x2028:
        case 0x2029:
          return 'ws';
      }
      if ((code >= 0x61 && code <= 0x7A) || (code >= 0x41 && code <= 0x5A)) {
        return 'ident';
      }
      if (code >= 0x31 && code <= 0x39) {
        return 'number';
      }
      return 'else';
    }
    function parsePath(path) {
      var keys = [];
      var index = -1;
      var mode = BEFORE_PATH;
      var c,
          newChar,
          key,
          type,
          transition,
          action,
          typeMap;
      var actions = [];
      actions[PUSH] = function() {
        if (key === undefined) {
          return;
        }
        keys.push(key);
        key = undefined;
      };
      actions[APPEND] = function() {
        if (key === undefined) {
          key = newChar;
        } else {
          key += newChar;
        }
      };
      function maybeUnescapeQuote() {
        var nextChar = path[index + 1];
        if ((mode === IN_SINGLE_QUOTE && nextChar === "'") || (mode === IN_DOUBLE_QUOTE && nextChar === '"')) {
          index++;
          newChar = nextChar;
          actions[APPEND]();
          return true;
        }
      }
      while (mode != null) {
        index++;
        c = path[index];
        if (c === '\\' && maybeUnescapeQuote()) {
          continue;
        }
        type = getPathCharType(c);
        typeMap = pathStateMachine[mode];
        transition = typeMap[type] || typeMap['else'] || ERROR;
        if (transition === ERROR) {
          return;
        }
        mode = transition[0];
        action = actions[transition[1]];
        if (action) {
          newChar = transition[2];
          newChar = newChar === undefined ? c : newChar === '*' ? newChar + c : newChar;
          action();
        }
        if (mode === AFTER_PATH) {
          keys.raw = path;
          return keys;
        }
      }
    }
    function formatAccessor(key) {
      if (identRE.test(key)) {
        return '.' + key;
      } else if (+key === key >>> 0) {
        return '[' + key + ']';
      } else if (key.charAt(0) === '*') {
        return '[o' + formatAccessor(key.slice(1)) + ']';
      } else {
        return '["' + key.replace(/"/g, '\\"') + '"]';
      }
    }
    exports.compileGetter = function(path) {
      var body = 'return o' + path.map(formatAccessor).join('');
      return new Function('o', body);
    };
    exports.parse = function(path) {
      var hit = pathCache.get(path);
      if (!hit) {
        hit = parsePath(path);
        if (hit) {
          hit.get = exports.compileGetter(hit);
          pathCache.put(path, hit);
        }
      }
      return hit;
    };
    exports.get = function(obj, path) {
      path = exports.parse(path);
      if (path) {
        return path.get(obj);
      }
    };
    var warnNonExistent;
    if (process.env.NODE_ENV !== 'production') {
      warnNonExistent = function(path) {
        _.warn('You are setting a non-existent path "' + path.raw + '" ' + 'on a vm instance. Consider pre-initializing the property ' + 'with the "data" option for more reliable reactivity ' + 'and better performance.');
      };
    }
    exports.set = function(obj, path, val) {
      var original = obj;
      if (typeof path === 'string') {
        path = exports.parse(path);
      }
      if (!path || !_.isObject(obj)) {
        return false;
      }
      var last,
          key;
      for (var i = 0,
          l = path.length; i < l; i++) {
        last = obj;
        key = path[i];
        if (key.charAt(0) === '*') {
          key = original[key.slice(1)];
        }
        if (i < l - 1) {
          obj = obj[key];
          if (!_.isObject(obj)) {
            obj = {};
            if (process.env.NODE_ENV !== 'production' && last._isVue) {
              warnNonExistent(path);
            }
            _.set(last, key, obj);
          }
        } else {
          if (_.isArray(obj)) {
            obj.$set(key, val);
          } else if (key in obj) {
            obj[key] = val;
          } else {
            if (process.env.NODE_ENV !== 'production' && obj._isVue) {
              warnNonExistent(path);
            }
            _.set(obj, key, val);
          }
        }
      }
      return true;
    };
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2e", ["10", "2d", "a", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var Path = req('2d');
    var Cache = req('a');
    var expressionCache = new Cache(1000);
    var allowedKeywords = 'Math,Date,this,true,false,null,undefined,Infinity,NaN,' + 'isNaN,isFinite,decodeURI,decodeURIComponent,encodeURI,' + 'encodeURIComponent,parseInt,parseFloat';
    var allowedKeywordsRE = new RegExp('^(' + allowedKeywords.replace(/,/g, '\\b|') + '\\b)');
    var improperKeywords = 'break,case,class,catch,const,continue,debugger,default,' + 'delete,do,else,export,extends,finally,for,function,if,' + 'import,in,instanceof,let,return,super,switch,throw,try,' + 'var,while,with,yield,enum,await,implements,package,' + 'proctected,static,interface,private,public';
    var improperKeywordsRE = new RegExp('^(' + improperKeywords.replace(/,/g, '\\b|') + '\\b)');
    var wsRE = /\s/g;
    var newlineRE = /\n/g;
    var saveRE = /[\{,]\s*[\w\$_]+\s*:|('[^']*'|"[^"]*")|new |typeof |void /g;
    var restoreRE = /"(\d+)"/g;
    var pathTestRE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*|\['.*?'\]|\[".*?"\]|\[\d+\]|\[[A-Za-z_$][\w$]*\])*$/;
    var pathReplaceRE = /[^\w$\.]([A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*|\['.*?'\]|\[".*?"\])*)/g;
    var booleanLiteralRE = /^(true|false)$/;
    var saved = [];
    function save(str, isString) {
      var i = saved.length;
      saved[i] = isString ? str.replace(newlineRE, '\\n') : str;
      return '"' + i + '"';
    }
    function rewrite(raw) {
      var c = raw.charAt(0);
      var path = raw.slice(1);
      if (allowedKeywordsRE.test(path)) {
        return raw;
      } else {
        path = path.indexOf('"') > -1 ? path.replace(restoreRE, restore) : path;
        return c + 'scope.' + path;
      }
    }
    function restore(str, i) {
      return saved[i];
    }
    function compileExpFns(exp, needSet) {
      if (improperKeywordsRE.test(exp)) {
        process.env.NODE_ENV !== 'production' && _.warn('Avoid using reserved keywords in expression: ' + exp);
      }
      saved.length = 0;
      var body = exp.replace(saveRE, save).replace(wsRE, '');
      body = (' ' + body).replace(pathReplaceRE, rewrite).replace(restoreRE, restore);
      var getter = makeGetter(body);
      if (getter) {
        return {
          get: getter,
          body: body,
          set: needSet ? makeSetter(body) : null
        };
      }
    }
    function compilePathFns(exp) {
      var getter,
          path;
      if (exp.indexOf('[') < 0) {
        path = exp.split('.');
        path.raw = exp;
        getter = Path.compileGetter(path);
      } else {
        path = Path.parse(exp);
        getter = path.get;
      }
      return {
        get: getter,
        set: function(obj, val) {
          Path.set(obj, path, val);
        }
      };
    }
    function makeGetter(body) {
      try {
        return new Function('scope', 'return ' + body + ';');
      } catch (e) {
        process.env.NODE_ENV !== 'production' && _.warn('Invalid expression. ' + 'Generated function body: ' + body);
      }
    }
    function makeSetter(body) {
      try {
        return new Function('scope', 'value', body + '=value;');
      } catch (e) {
        process.env.NODE_ENV !== 'production' && _.warn('Invalid setter function body: ' + body);
      }
    }
    function checkSetter(hit) {
      if (!hit.set) {
        hit.set = makeSetter(hit.body);
      }
    }
    exports.parse = function(exp, needSet) {
      exp = exp.trim();
      var hit = expressionCache.get(exp);
      if (hit) {
        if (needSet) {
          checkSetter(hit);
        }
        return hit;
      }
      var res = exports.isSimplePath(exp) ? compilePathFns(exp) : compileExpFns(exp, needSet);
      expressionCache.put(exp, res);
      return res;
    };
    exports.isSimplePath = function(exp) {
      return pathTestRE.test(exp) && !booleanLiteralRE.test(exp) && exp.slice(0, 5) !== 'Math.';
    };
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2f", ["10", "12", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var config = req('12');
    var queue = [];
    var userQueue = [];
    var has = {};
    var circular = {};
    var waiting = false;
    var internalQueueDepleted = false;
    function resetBatcherState() {
      queue = [];
      userQueue = [];
      has = {};
      circular = {};
      waiting = internalQueueDepleted = false;
    }
    function flushBatcherQueue() {
      runBatcherQueue(queue);
      internalQueueDepleted = true;
      runBatcherQueue(userQueue);
      resetBatcherState();
    }
    function runBatcherQueue(queue) {
      for (var i = 0; i < queue.length; i++) {
        var watcher = queue[i];
        var id = watcher.id;
        has[id] = null;
        watcher.run();
        if (process.env.NODE_ENV !== 'production' && has[id] != null) {
          circular[id] = (circular[id] || 0) + 1;
          if (circular[id] > config._maxUpdateCount) {
            queue.splice(has[id], 1);
            _.warn('You may have an infinite update loop for watcher ' + 'with expression: ' + watcher.expression);
          }
        }
      }
    }
    exports.push = function(watcher) {
      var id = watcher.id;
      if (has[id] == null) {
        if (internalQueueDepleted && !watcher.user) {
          watcher.run();
          return;
        }
        var q = watcher.user ? userQueue : queue;
        has[id] = q.length;
        q.push(watcher);
        if (!waiting) {
          waiting = true;
          _.nextTick(flushBatcherQueue);
        }
      }
    };
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("30", ["10", "12", "2c", "2e", "2f", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var config = req('12');
    var Dep = req('2c');
    var expParser = req('2e');
    var batcher = req('2f');
    var uid = 0;
    function Watcher(vm, expOrFn, cb, options) {
      if (options) {
        _.extend(this, options);
      }
      var isFn = typeof expOrFn === 'function';
      this.vm = vm;
      vm._watchers.push(this);
      this.expression = isFn ? expOrFn.toString() : expOrFn;
      this.cb = cb;
      this.id = ++uid;
      this.active = true;
      this.dirty = this.lazy;
      this.deps = Object.create(null);
      this.newDeps = null;
      this.prevError = null;
      if (isFn) {
        this.getter = expOrFn;
        this.setter = undefined;
      } else {
        var res = expParser.parse(expOrFn, this.twoWay);
        this.getter = res.get;
        this.setter = res.set;
      }
      this.value = this.lazy ? undefined : this.get();
      this.queued = this.shallow = false;
    }
    Watcher.prototype.addDep = function(dep) {
      var id = dep.id;
      if (!this.newDeps[id]) {
        this.newDeps[id] = dep;
        if (!this.deps[id]) {
          this.deps[id] = dep;
          dep.addSub(this);
        }
      }
    };
    Watcher.prototype.get = function() {
      this.beforeGet();
      var scope = this.scope || this.vm;
      var value;
      try {
        value = this.getter.call(scope, scope);
      } catch (e) {
        if (process.env.NODE_ENV !== 'production' && config.warnExpressionErrors) {
          _.warn('Error when evaluating expression "' + this.expression + '". ' + (config.debug ? '' : 'Turn on debug mode to see stack trace.'), e);
        }
      }
      if (this.deep) {
        traverse(value);
      }
      if (this.preProcess) {
        value = this.preProcess(value);
      }
      if (this.filters) {
        value = scope._applyFilters(value, null, this.filters, false);
      }
      if (this.postProcess) {
        value = this.postProcess(value);
      }
      this.afterGet();
      return value;
    };
    Watcher.prototype.set = function(value) {
      var scope = this.scope || this.vm;
      if (this.filters) {
        value = scope._applyFilters(value, this.value, this.filters, true);
      }
      try {
        this.setter.call(scope, scope, value);
      } catch (e) {
        if (process.env.NODE_ENV !== 'production' && config.warnExpressionErrors) {
          _.warn('Error when evaluating setter "' + this.expression + '"', e);
        }
      }
      var forContext = scope.$forContext;
      if (process.env.NODE_ENV !== 'production') {
        if (forContext && forContext.filters && (new RegExp(forContext.alias + '\\b')).test(this.expression)) {
          _.warn('It seems you are using two-way binding on ' + 'a v-for alias (' + this.expression + '), and the ' + 'v-for has filters. This will not work properly. ' + 'Either remove the filters or use an array of ' + 'objects and bind to object properties instead.');
        }
      }
      if (forContext && forContext.alias === this.expression && !forContext.filters) {
        if (scope.$key) {
          forContext.rawValue[scope.$key] = value;
        } else {
          forContext.rawValue.$set(scope.$index, value);
        }
      }
    };
    Watcher.prototype.beforeGet = function() {
      Dep.target = this;
      this.newDeps = Object.create(null);
    };
    Watcher.prototype.afterGet = function() {
      Dep.target = null;
      var ids = Object.keys(this.deps);
      var i = ids.length;
      while (i--) {
        var id = ids[i];
        if (!this.newDeps[id]) {
          this.deps[id].removeSub(this);
        }
      }
      this.deps = this.newDeps;
    };
    Watcher.prototype.update = function(shallow) {
      if (this.lazy) {
        this.dirty = true;
      } else if (this.sync || !config.async) {
        this.run();
      } else {
        this.shallow = this.queued ? shallow ? this.shallow : false : !!shallow;
        this.queued = true;
        if (process.env.NODE_ENV !== 'production' && config.debug) {
          this.prevError = new Error('[vue] async stack trace');
        }
        batcher.push(this);
      }
    };
    Watcher.prototype.run = function() {
      if (this.active) {
        var value = this.get();
        if (value !== this.value || ((_.isArray(value) || this.deep) && !this.shallow)) {
          var oldValue = this.value;
          this.value = value;
          var prevError = this.prevError;
          if (process.env.NODE_ENV !== 'production' && config.debug && prevError) {
            this.prevError = null;
            try {
              this.cb.call(this.vm, value, oldValue);
            } catch (e) {
              _.nextTick(function() {
                throw prevError;
              }, 0);
              throw e;
            }
          } else {
            this.cb.call(this.vm, value, oldValue);
          }
        }
        this.queued = this.shallow = false;
      }
    };
    Watcher.prototype.evaluate = function() {
      var current = Dep.target;
      this.value = this.get();
      this.dirty = false;
      Dep.target = current;
    };
    Watcher.prototype.depend = function() {
      var depIds = Object.keys(this.deps);
      var i = depIds.length;
      while (i--) {
        this.deps[depIds[i]].depend();
      }
    };
    Watcher.prototype.teardown = function() {
      if (this.active) {
        if (!this.vm._isBeingDestroyed) {
          this.vm._watchers.$remove(this);
        }
        var depIds = Object.keys(this.deps);
        var i = depIds.length;
        while (i--) {
          this.deps[depIds[i]].removeSub(this);
        }
        this.active = false;
        this.vm = this.cb = this.value = null;
      }
    };
    function traverse(obj) {
      var key,
          val,
          i;
      for (key in obj) {
        val = obj[key];
        if (_.isArray(val)) {
          i = val.length;
          while (i--)
            traverse(val[i]);
        } else if (_.isObject(val)) {
          traverse(val);
        }
      }
    }
    module.exports = Watcher;
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("31", ["10", "30", "12"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var Watcher = req('30');
  var bindingModes = req('12')._propBindingModes;
  module.exports = {
    bind: function() {
      var child = this.vm;
      var parent = child._context;
      var prop = this.descriptor.prop;
      var childKey = prop.path;
      var parentKey = prop.parentPath;
      var twoWay = prop.mode === bindingModes.TWO_WAY;
      var parentWatcher = this.parentWatcher = new Watcher(parent, parentKey, function(val) {
        if (_.assertProp(prop, val)) {
          child[childKey] = val;
        }
      }, {
        twoWay: twoWay,
        filters: prop.filters,
        scope: this._scope
      });
      _.initProp(child, prop, parentWatcher.value);
      if (twoWay) {
        var self = this;
        child.$once('hook:created', function() {
          self.childWatcher = new Watcher(child, childKey, function(val) {
            parentWatcher.set(val);
          });
        });
      }
    },
    unbind: function() {
      this.parentWatcher.teardown();
      if (this.childWatcher) {
        this.childWatcher.teardown();
      }
    }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("32", ["10"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var queue = [];
  var queued = false;
  exports.push = function(job) {
    queue.push(job);
    if (!queued) {
      queued = true;
      _.nextTick(flush);
    }
  };
  function flush() {
    var f = document.documentElement.offsetHeight;
    for (var i = 0; i < queue.length; i++) {
      queue[i]();
    }
    queue = [];
    queued = false;
    return f;
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("33", ["10", "32"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var queue = req('32');
  var addClass = _.addClass;
  var removeClass = _.removeClass;
  var transitionEndEvent = _.transitionEndEvent;
  var animationEndEvent = _.animationEndEvent;
  var transDurationProp = _.transitionProp + 'Duration';
  var animDurationProp = _.animationProp + 'Duration';
  var TYPE_TRANSITION = 1;
  var TYPE_ANIMATION = 2;
  function Transition(el, id, hooks, vm) {
    this.id = id;
    this.el = el;
    this.enterClass = id + '-enter';
    this.leaveClass = id + '-leave';
    this.hooks = hooks;
    this.vm = vm;
    this.pendingCssEvent = this.pendingCssCb = this.cancel = this.pendingJsCb = this.op = this.cb = null;
    this.justEntered = false;
    this.entered = this.left = false;
    this.typeCache = {};
    var self = this;
    ;
    ['enterNextTick', 'enterDone', 'leaveNextTick', 'leaveDone'].forEach(function(m) {
      self[m] = _.bind(self[m], self);
    });
  }
  var p = Transition.prototype;
  p.enter = function(op, cb) {
    this.cancelPending();
    this.callHook('beforeEnter');
    this.cb = cb;
    addClass(this.el, this.enterClass);
    op();
    this.entered = false;
    this.callHookWithCb('enter');
    if (this.entered) {
      return;
    }
    this.cancel = this.hooks && this.hooks.enterCancelled;
    queue.push(this.enterNextTick);
  };
  p.enterNextTick = function() {
    this.justEntered = true;
    var self = this;
    setTimeout(function() {
      self.justEntered = false;
    }, 17);
    var enterDone = this.enterDone;
    var type = this.getCssTransitionType(this.enterClass);
    if (!this.pendingJsCb) {
      if (type === TYPE_TRANSITION) {
        removeClass(this.el, this.enterClass);
        this.setupCssCb(transitionEndEvent, enterDone);
      } else if (type === TYPE_ANIMATION) {
        this.setupCssCb(animationEndEvent, enterDone);
      } else {
        enterDone();
      }
    } else if (type === TYPE_TRANSITION) {
      removeClass(this.el, this.enterClass);
    }
  };
  p.enterDone = function() {
    this.entered = true;
    this.cancel = this.pendingJsCb = null;
    removeClass(this.el, this.enterClass);
    this.callHook('afterEnter');
    if (this.cb)
      this.cb();
  };
  p.leave = function(op, cb) {
    this.cancelPending();
    this.callHook('beforeLeave');
    this.op = op;
    this.cb = cb;
    addClass(this.el, this.leaveClass);
    this.left = false;
    this.callHookWithCb('leave');
    if (this.left) {
      return;
    }
    this.cancel = this.hooks && this.hooks.leaveCancelled;
    if (this.op && !this.pendingJsCb) {
      if (this.justEntered) {
        this.leaveDone();
      } else {
        queue.push(this.leaveNextTick);
      }
    }
  };
  p.leaveNextTick = function() {
    var type = this.getCssTransitionType(this.leaveClass);
    if (type) {
      var event = type === TYPE_TRANSITION ? transitionEndEvent : animationEndEvent;
      this.setupCssCb(event, this.leaveDone);
    } else {
      this.leaveDone();
    }
  };
  p.leaveDone = function() {
    this.left = true;
    this.cancel = this.pendingJsCb = null;
    this.op();
    removeClass(this.el, this.leaveClass);
    this.callHook('afterLeave');
    if (this.cb)
      this.cb();
    this.op = null;
  };
  p.cancelPending = function() {
    this.op = this.cb = null;
    var hasPending = false;
    if (this.pendingCssCb) {
      hasPending = true;
      _.off(this.el, this.pendingCssEvent, this.pendingCssCb);
      this.pendingCssEvent = this.pendingCssCb = null;
    }
    if (this.pendingJsCb) {
      hasPending = true;
      this.pendingJsCb.cancel();
      this.pendingJsCb = null;
    }
    if (hasPending) {
      removeClass(this.el, this.enterClass);
      removeClass(this.el, this.leaveClass);
    }
    if (this.cancel) {
      this.cancel.call(this.vm, this.el);
      this.cancel = null;
    }
  };
  p.callHook = function(type) {
    if (this.hooks && this.hooks[type]) {
      this.hooks[type].call(this.vm, this.el);
    }
  };
  p.callHookWithCb = function(type) {
    var hook = this.hooks && this.hooks[type];
    if (hook) {
      if (hook.length > 1) {
        this.pendingJsCb = _.cancellable(this[type + 'Done']);
      }
      hook.call(this.vm, this.el, this.pendingJsCb);
    }
  };
  p.getCssTransitionType = function(className) {
    if (!transitionEndEvent || document.hidden || (this.hooks && this.hooks.css === false) || isHidden(this.el)) {
      return;
    }
    var type = this.typeCache[className];
    if (type)
      return type;
    var inlineStyles = this.el.style;
    var computedStyles = window.getComputedStyle(this.el);
    var transDuration = inlineStyles[transDurationProp] || computedStyles[transDurationProp];
    if (transDuration && transDuration !== '0s') {
      type = TYPE_TRANSITION;
    } else {
      var animDuration = inlineStyles[animDurationProp] || computedStyles[animDurationProp];
      if (animDuration && animDuration !== '0s') {
        type = TYPE_ANIMATION;
      }
    }
    if (type) {
      this.typeCache[className] = type;
    }
    return type;
  };
  p.setupCssCb = function(event, cb) {
    this.pendingCssEvent = event;
    var self = this;
    var el = this.el;
    var onEnd = this.pendingCssCb = function(e) {
      if (e.target === el) {
        _.off(el, event, onEnd);
        self.pendingCssEvent = self.pendingCssCb = null;
        if (!self.pendingJsCb && cb) {
          cb();
        }
      }
    };
    _.on(el, event, onEnd);
  };
  function isHidden(el) {
    return !(el.offsetWidth && el.offsetHeight && el.getClientRects().length);
  }
  module.exports = Transition;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("34", ["10", "33"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var Transition = req('33');
  module.exports = {
    priority: 1000,
    update: function(id, oldId) {
      var el = this.el;
      var hooks = _.resolveAsset(this.vm.$options, 'transitions', id);
      id = id || 'v';
      el.__v_trans = new Transition(el, id, hooks, this.el.__vue__ || this.vm);
      if (oldId) {
        _.removeClass(el, oldId + '-transition');
      }
      _.addClass(el, id + '-transition');
    }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("35", ["29", "2a", "2b", "31", "34"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  exports.style = req('29');
  exports['class'] = req('2a');
  exports.component = req('2b');
  exports.prop = req('31');
  exports.transition = req('34');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("36", ["10", "f", "31", "12", "2d", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var dirParser = req('f');
    var propDef = req('31');
    var propBindingModes = req('12')._propBindingModes;
    var empty = {};
    var identRE = req('2d').identRE;
    var settablePathRE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*|\[[^\[\]]+\])*$/;
    module.exports = function compileProps(el, propOptions) {
      var props = [];
      var names = Object.keys(propOptions);
      var i = names.length;
      var options,
          name,
          attr,
          value,
          path,
          parsed,
          prop;
      while (i--) {
        name = names[i];
        options = propOptions[name] || empty;
        if (process.env.NODE_ENV !== 'production' && name === '$data') {
          _.warn('Do not use $data as prop.');
          continue;
        }
        path = _.camelize(name);
        if (!identRE.test(path)) {
          process.env.NODE_ENV !== 'production' && _.warn('Invalid prop key: "' + name + '". Prop keys ' + 'must be valid identifiers.');
          continue;
        }
        prop = {
          name: name,
          path: path,
          options: options,
          mode: propBindingModes.ONE_WAY
        };
        attr = _.hyphenate(name);
        value = prop.raw = _.attr(el, attr);
        if (value === null) {
          if ((value = _.getBindAttr(el, attr)) === null) {
            if ((value = _.getBindAttr(el, attr + '.sync')) !== null) {
              prop.mode = propBindingModes.TWO_WAY;
            } else if ((value = _.getBindAttr(el, attr + '.once')) !== null) {
              prop.mode = propBindingModes.ONE_TIME;
            }
          }
          prop.raw = value;
          if (value !== null) {
            parsed = dirParser.parse(value);
            value = parsed.expression;
            prop.filters = parsed.filters;
            if (_.isLiteral(value)) {
              prop.optimizedLiteral = true;
            } else {
              prop.dynamic = true;
              if (process.env.NODE_ENV !== 'production' && prop.mode === propBindingModes.TWO_WAY && !settablePathRE.test(value)) {
                prop.mode = propBindingModes.ONE_WAY;
                _.warn('Cannot bind two-way prop with non-settable ' + 'parent path: ' + value);
              }
            }
            prop.parentPath = value;
            if (process.env.NODE_ENV !== 'production' && options.twoWay && prop.mode !== propBindingModes.TWO_WAY) {
              _.warn('Prop "' + name + '" expects a two-way binding type.');
            }
          } else if (options.required) {
            process.env.NODE_ENV !== 'production' && _.warn('Missing required prop: ' + name);
          }
        }
        props.push(prop);
      }
      return makePropsLinkFn(props);
    };
    function makePropsLinkFn(props) {
      return function propsLinkFn(vm, scope) {
        vm._props = {};
        var i = props.length;
        var prop,
            path,
            options,
            value,
            raw;
        while (i--) {
          prop = props[i];
          raw = prop.raw;
          path = prop.path;
          options = prop.options;
          vm._props[path] = prop;
          if (raw === null) {
            _.initProp(vm, prop, getDefault(vm, options));
          } else if (prop.dynamic) {
            if (vm._context) {
              if (prop.mode === propBindingModes.ONE_TIME) {
                value = (scope || vm._context).$get(prop.parentPath);
                _.initProp(vm, prop, value);
              } else {
                vm._bindDir({
                  name: 'prop',
                  def: propDef,
                  prop: prop
                }, null, null, scope);
              }
            } else {
              process.env.NODE_ENV !== 'production' && _.warn('Cannot bind dynamic prop on a root instance' + ' with no parent: ' + prop.name + '="' + raw + '"');
            }
          } else if (prop.optimizedLiteral) {
            raw = _.stripQuotes(raw);
            value = _.toBoolean(_.toNumber(raw));
            _.initProp(vm, prop, value);
          } else {
            value = options.type === Boolean && raw === '' ? true : raw;
            _.initProp(vm, prop, value);
          }
        }
      };
    }
    function getDefault(vm, options) {
      if (!options.hasOwnProperty('default')) {
        return options.type === Boolean ? false : undefined;
      }
      var def = options.default;
      if (_.isObject(def)) {
        process.env.NODE_ENV !== 'production' && _.warn('Object/Array as default prop values will be shared ' + 'across multiple instances. Use a factory function ' + 'to return the default value instead.');
      }
      return typeof def === 'function' && options.type !== Function ? def.call(vm) : def;
    }
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("37", ["10", "28", "35", "36", "11", "f", "16", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var publicDirectives = req('28');
    var internalDirectives = req('35');
    var compileProps = req('36');
    var textParser = req('11');
    var dirParser = req('f');
    var templateParser = req('16');
    var resolveAsset = _.resolveAsset;
    var bindRE = /^v-bind:|^:/;
    var onRE = /^v-on:|^@/;
    var argRE = /:(.*)$/;
    var modifierRE = /\.[^\.]+/g;
    var transitionRE = /^(v-bind:|:)?transition$/;
    var terminalDirectives = ['for', 'if'];
    exports.compile = function(el, options, partial) {
      var nodeLinkFn = partial || !options._asComponent ? compileNode(el, options) : null;
      var childLinkFn = !(nodeLinkFn && nodeLinkFn.terminal) && el.tagName !== 'SCRIPT' && el.hasChildNodes() ? compileNodeList(el.childNodes, options) : null;
      return function compositeLinkFn(vm, el, host, scope, frag) {
        var childNodes = _.toArray(el.childNodes);
        var dirs = linkAndCapture(function compositeLinkCapturer() {
          if (nodeLinkFn)
            nodeLinkFn(vm, el, host, scope, frag);
          if (childLinkFn)
            childLinkFn(vm, childNodes, host, scope, frag);
        }, vm);
        return makeUnlinkFn(vm, dirs);
      };
    };
    function linkAndCapture(linker, vm) {
      var originalDirCount = vm._directives.length;
      linker();
      var dirs = vm._directives.slice(originalDirCount);
      dirs.sort(directiveComparator);
      for (var i = 0,
          l = dirs.length; i < l; i++) {
        dirs[i]._bind();
      }
      return dirs;
    }
    function directiveComparator(a, b) {
      a = a.descriptor.def.priority || 0;
      b = b.descriptor.def.priority || 0;
      return a > b ? -1 : a === b ? 0 : 1;
    }
    function makeUnlinkFn(vm, dirs, context, contextDirs) {
      return function unlink(destroying) {
        teardownDirs(vm, dirs, destroying);
        if (context && contextDirs) {
          teardownDirs(context, contextDirs);
        }
      };
    }
    function teardownDirs(vm, dirs, destroying) {
      var i = dirs.length;
      while (i--) {
        dirs[i]._teardown();
        if (!destroying) {
          vm._directives.$remove(dirs[i]);
        }
      }
    }
    exports.compileAndLinkProps = function(vm, el, props, scope) {
      var propsLinkFn = compileProps(el, props);
      var propDirs = linkAndCapture(function() {
        propsLinkFn(vm, scope);
      }, vm);
      return makeUnlinkFn(vm, propDirs);
    };
    exports.compileRoot = function(el, options, contextOptions) {
      var containerAttrs = options._containerAttrs;
      var replacerAttrs = options._replacerAttrs;
      var contextLinkFn,
          replacerLinkFn;
      if (el.nodeType !== 11) {
        if (options._asComponent) {
          if (containerAttrs && contextOptions) {
            contextLinkFn = compileDirectives(containerAttrs, contextOptions);
          }
          if (replacerAttrs) {
            replacerLinkFn = compileDirectives(replacerAttrs, options);
          }
        } else {
          replacerLinkFn = compileDirectives(el.attributes, options);
        }
      } else if (process.env.NODE_ENV !== 'production' && containerAttrs) {
        containerAttrs.forEach(function(attr) {
          if (attr.name.indexOf('v-') === 0 || attr.name === 'transition') {
            _.warn(attr.name + ' is ignored on component ' + '<' + options.el.tagName.toLowerCase() + '> because ' + 'the component is a fragment instance: ' + 'http://vuejs.org/guide/components.html#Fragment_Instance');
          }
        });
      }
      return function rootLinkFn(vm, el, scope) {
        var context = vm._context;
        var contextDirs;
        if (context && contextLinkFn) {
          contextDirs = linkAndCapture(function() {
            contextLinkFn(context, el, null, scope);
          }, context);
        }
        var selfDirs = linkAndCapture(function() {
          if (replacerLinkFn)
            replacerLinkFn(vm, el);
        }, vm);
        return makeUnlinkFn(vm, selfDirs, context, contextDirs);
      };
    };
    function compileNode(node, options) {
      var type = node.nodeType;
      if (type === 1 && node.tagName !== 'SCRIPT') {
        return compileElement(node, options);
      } else if (type === 3 && node.data.trim()) {
        return compileTextNode(node, options);
      } else {
        return null;
      }
    }
    function compileElement(el, options) {
      if (el.tagName === 'TEXTAREA') {
        var tokens = textParser.parse(el.value);
        if (tokens) {
          el.setAttribute(':value', textParser.tokensToExp(tokens));
          el.value = '';
        }
      }
      var linkFn;
      var hasAttrs = el.hasAttributes();
      if (hasAttrs) {
        linkFn = checkTerminalDirectives(el, options);
      }
      if (!linkFn) {
        linkFn = checkElementDirectives(el, options);
      }
      if (!linkFn) {
        linkFn = checkComponent(el, options);
      }
      if (!linkFn && hasAttrs) {
        linkFn = compileDirectives(el.attributes, options);
      }
      return linkFn;
    }
    function compileTextNode(node, options) {
      var tokens = textParser.parse(node.data);
      if (!tokens) {
        return null;
      }
      var frag = document.createDocumentFragment();
      var el,
          token;
      for (var i = 0,
          l = tokens.length; i < l; i++) {
        token = tokens[i];
        el = token.tag ? processTextToken(token, options) : document.createTextNode(token.value);
        frag.appendChild(el);
      }
      return makeTextNodeLinkFn(tokens, frag, options);
    }
    function processTextToken(token, options) {
      var el;
      if (token.oneTime) {
        el = document.createTextNode(token.value);
      } else {
        if (token.html) {
          el = document.createComment('v-html');
          setTokenType('html');
        } else {
          el = document.createTextNode(' ');
          setTokenType('text');
        }
      }
      function setTokenType(type) {
        if (token.descriptor)
          return;
        var parsed = dirParser.parse(token.value);
        token.descriptor = {
          name: type,
          def: publicDirectives[type],
          expression: parsed.expression,
          filters: parsed.filters
        };
      }
      return el;
    }
    function makeTextNodeLinkFn(tokens, frag) {
      return function textNodeLinkFn(vm, el, host, scope) {
        var fragClone = frag.cloneNode(true);
        var childNodes = _.toArray(fragClone.childNodes);
        var token,
            value,
            node;
        for (var i = 0,
            l = tokens.length; i < l; i++) {
          token = tokens[i];
          value = token.value;
          if (token.tag) {
            node = childNodes[i];
            if (token.oneTime) {
              value = (scope || vm).$eval(value);
              if (token.html) {
                _.replace(node, templateParser.parse(value, true));
              } else {
                node.data = value;
              }
            } else {
              vm._bindDir(token.descriptor, node, host, scope);
            }
          }
        }
        _.replace(el, fragClone);
      };
    }
    function compileNodeList(nodeList, options) {
      var linkFns = [];
      var nodeLinkFn,
          childLinkFn,
          node;
      for (var i = 0,
          l = nodeList.length; i < l; i++) {
        node = nodeList[i];
        nodeLinkFn = compileNode(node, options);
        childLinkFn = !(nodeLinkFn && nodeLinkFn.terminal) && node.tagName !== 'SCRIPT' && node.hasChildNodes() ? compileNodeList(node.childNodes, options) : null;
        linkFns.push(nodeLinkFn, childLinkFn);
      }
      return linkFns.length ? makeChildLinkFn(linkFns) : null;
    }
    function makeChildLinkFn(linkFns) {
      return function childLinkFn(vm, nodes, host, scope, frag) {
        var node,
            nodeLinkFn,
            childrenLinkFn;
        for (var i = 0,
            n = 0,
            l = linkFns.length; i < l; n++) {
          node = nodes[n];
          nodeLinkFn = linkFns[i++];
          childrenLinkFn = linkFns[i++];
          var childNodes = _.toArray(node.childNodes);
          if (nodeLinkFn) {
            nodeLinkFn(vm, node, host, scope, frag);
          }
          if (childrenLinkFn) {
            childrenLinkFn(vm, childNodes, host, scope, frag);
          }
        }
      };
    }
    function checkElementDirectives(el, options) {
      var tag = el.tagName.toLowerCase();
      if (_.commonTagRE.test(tag))
        return;
      var def = resolveAsset(options, 'elementDirectives', tag);
      if (def) {
        return makeTerminalNodeLinkFn(el, tag, '', options, def);
      }
    }
    function checkComponent(el, options) {
      var component = _.checkComponent(el, options);
      if (component) {
        var descriptor = {
          name: 'component',
          expression: component.id,
          def: internalDirectives.component,
          modifiers: {literal: !component.dynamic}
        };
        var componentLinkFn = function(vm, el, host, scope, frag) {
          vm._bindDir(descriptor, el, host, scope, frag);
        };
        componentLinkFn.terminal = true;
        return componentLinkFn;
      }
    }
    function checkTerminalDirectives(el, options) {
      if (_.attr(el, 'v-pre') !== null) {
        return skip;
      }
      if (el.hasAttribute('v-else')) {
        var prev = el.previousElementSibling;
        if (prev && prev.hasAttribute('v-if')) {
          return skip;
        }
      }
      var value,
          dirName;
      for (var i = 0,
          l = terminalDirectives.length; i < l; i++) {
        dirName = terminalDirectives[i];
        if (value = el.getAttribute('v-' + dirName)) {
          return makeTerminalNodeLinkFn(el, dirName, value, options);
        }
      }
    }
    function skip() {}
    skip.terminal = true;
    function makeTerminalNodeLinkFn(el, dirName, value, options, def) {
      var parsed = dirParser.parse(value);
      var descriptor = {
        name: dirName,
        expression: parsed.expression,
        filters: parsed.filters,
        raw: value,
        def: def || publicDirectives[dirName]
      };
      var fn = function terminalNodeLinkFn(vm, el, host, scope, frag) {
        vm._bindDir(descriptor, el, host, scope, frag);
      };
      fn.terminal = true;
      return fn;
    }
    function compileDirectives(attrs, options) {
      var i = attrs.length;
      var dirs = [];
      var attr,
          name,
          value,
          rawName,
          rawValue,
          dirName,
          arg,
          modifiers,
          dirDef,
          tokens;
      while (i--) {
        attr = attrs[i];
        name = rawName = attr.name;
        value = rawValue = attr.value;
        tokens = textParser.parse(value);
        arg = null;
        modifiers = parseModifiers(name);
        name = name.replace(modifierRE, '');
        if (tokens) {
          value = textParser.tokensToExp(tokens);
          arg = name;
          pushDir('bind', publicDirectives.bind, true);
        } else if (transitionRE.test(name)) {
          modifiers.literal = !bindRE.test(name);
          pushDir('transition', internalDirectives.transition);
        } else if (onRE.test(name)) {
          arg = name.replace(onRE, '');
          pushDir('on', publicDirectives.on);
        } else if (bindRE.test(name)) {
          dirName = name.replace(bindRE, '');
          if (dirName === 'style' || dirName === 'class') {
            pushDir(dirName, internalDirectives[dirName]);
          } else {
            arg = dirName;
            pushDir('bind', publicDirectives.bind);
          }
        } else if (name.indexOf('v-') === 0) {
          arg = (arg = name.match(argRE)) && arg[1];
          if (arg) {
            name = name.replace(argRE, '');
          }
          dirName = name.slice(2);
          if (dirName === 'else') {
            continue;
          }
          dirDef = resolveAsset(options, 'directives', dirName);
          if (process.env.NODE_ENV !== 'production') {
            _.assertAsset(dirDef, 'directive', dirName);
          }
          if (dirDef) {
            if (_.isLiteral(value)) {
              value = _.stripQuotes(value);
              modifiers.literal = true;
            }
            pushDir(dirName, dirDef);
          }
        }
      }
      function pushDir(dirName, def, interp) {
        var parsed = dirParser.parse(value);
        dirs.push({
          name: dirName,
          attr: rawName,
          raw: rawValue,
          def: def,
          arg: arg,
          modifiers: modifiers,
          expression: parsed.expression,
          filters: parsed.filters,
          interp: interp
        });
      }
      if (dirs.length) {
        return makeNodeLinkFn(dirs);
      }
    }
    function parseModifiers(name) {
      var res = Object.create(null);
      var match = name.match(modifierRE);
      if (match) {
        var i = match.length;
        while (i--) {
          res[match[i].slice(1)] = true;
        }
      }
      return res;
    }
    function makeNodeLinkFn(directives) {
      return function nodeLinkFn(vm, el, host, scope, frag) {
        var i = directives.length;
        while (i--) {
          vm._bindDir(directives[i], el, host, scope, frag);
        }
      };
    }
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("38", ["10", "16", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var templateParser = req('16');
    var specialCharRE = /[^\w\-:\.]/;
    exports.transclude = function(el, options) {
      if (options) {
        options._containerAttrs = extractAttrs(el);
      }
      if (_.isTemplate(el)) {
        el = templateParser.parse(el);
      }
      if (options) {
        if (options._asComponent && !options.template) {
          options.template = '<slot></slot>';
        }
        if (options.template) {
          options._content = _.extractContent(el);
          el = transcludeTemplate(el, options);
        }
      }
      if (el instanceof DocumentFragment) {
        _.prepend(_.createAnchor('v-start', true), el);
        el.appendChild(_.createAnchor('v-end', true));
      }
      return el;
    };
    function transcludeTemplate(el, options) {
      var template = options.template;
      var frag = templateParser.parse(template, true);
      if (frag) {
        var replacer = frag.firstChild;
        var tag = replacer.tagName && replacer.tagName.toLowerCase();
        if (options.replace) {
          if (el === document.body) {
            process.env.NODE_ENV !== 'production' && _.warn('You are mounting an instance with a template to ' + '<body>. This will replace <body> entirely. You ' + 'should probably use `replace: false` here.');
          }
          if (frag.childNodes.length > 1 || replacer.nodeType !== 1 || tag === 'component' || _.resolveAsset(options, 'components', tag) || replacer.hasAttribute('is') || replacer.hasAttribute(':is') || replacer.hasAttribute('v-bind:is') || _.resolveAsset(options, 'elementDirectives', tag) || replacer.hasAttribute('v-for') || replacer.hasAttribute('v-if')) {
            return frag;
          } else {
            options._replacerAttrs = extractAttrs(replacer);
            mergeAttrs(el, replacer);
            return replacer;
          }
        } else {
          el.appendChild(frag);
          return el;
        }
      } else {
        process.env.NODE_ENV !== 'production' && _.warn('Invalid template option: ' + template);
      }
    }
    function extractAttrs(el) {
      if (el.nodeType === 1 && el.hasAttributes()) {
        return _.toArray(el.attributes);
      }
    }
    function mergeAttrs(from, to) {
      var attrs = from.attributes;
      var i = attrs.length;
      var name,
          value;
      while (i--) {
        name = attrs[i].name;
        value = attrs[i].value;
        if (!to.hasAttribute(name) && !specialCharRE.test(name)) {
          to.setAttribute(name, value);
        } else if (name === 'class') {
          value = to.getAttribute(name) + ' ' + value;
          to.setAttribute(name, value);
        }
      }
    }
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1a", ["10", "37", "38"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  _.extend(exports, req('37'));
  _.extend(exports, req('38'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("39", ["10", "12", "1a", "19", "35", "2d", "11", "16", "f", "2e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var config = req('12');
  exports.util = _;
  exports.config = config;
  exports.set = _.set;
  exports.delete = _.delete;
  exports.nextTick = _.nextTick;
  exports.compiler = req('1a');
  exports.FragmentFactory = req('19');
  exports.internalDirectives = req('35');
  exports.parsers = {
    path: req('2d'),
    text: req('11'),
    template: req('16'),
    directive: req('f'),
    expression: req('2e')
  };
  exports.cid = 0;
  var cid = 1;
  exports.extend = function(extendOptions) {
    extendOptions = extendOptions || {};
    var Super = this;
    var isFirstExtend = Super.cid === 0;
    if (isFirstExtend && extendOptions._Ctor) {
      return extendOptions._Ctor;
    }
    var name = extendOptions.name || Super.options.name;
    var Sub = createClass(name || 'VueComponent');
    Sub.prototype = Object.create(Super.prototype);
    Sub.prototype.constructor = Sub;
    Sub.cid = cid++;
    Sub.options = _.mergeOptions(Super.options, extendOptions);
    Sub['super'] = Super;
    Sub.extend = Super.extend;
    config._assetTypes.forEach(function(type) {
      Sub[type] = Super[type];
    });
    if (name) {
      Sub.options.components[name] = Sub;
    }
    if (isFirstExtend) {
      extendOptions._Ctor = Sub;
    }
    return Sub;
  };
  function createClass(name) {
    return new Function('return function ' + _.classify(name) + ' (options) { this._init(options) }')();
  }
  exports.use = function(plugin) {
    if (plugin.installed) {
      return;
    }
    var args = _.toArray(arguments, 1);
    args.unshift(this);
    if (typeof plugin.install === 'function') {
      plugin.install.apply(plugin, args);
    } else {
      plugin.apply(null, args);
    }
    plugin.installed = true;
    return this;
  };
  exports.mixin = function(mixin) {
    var Vue = _.Vue;
    Vue.options = _.mergeOptions(Vue.options, mixin);
  };
  config._assetTypes.forEach(function(type) {
    exports[type] = function(id, definition) {
      if (!definition) {
        return this.options[type + 's'][id];
      } else {
        if (type === 'component' && _.isPlainObject(definition)) {
          definition.name = id;
          definition = _.Vue.extend(definition);
        }
        this.options[type + 's'][id] = definition;
        return definition;
      }
    };
  });
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3a", ["10", "16"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var templateParser = req('16');
  module.exports = {
    priority: 1750,
    params: ['name'],
    bind: function() {
      var host = this.vm;
      var raw = host.$options._content;
      var content;
      if (!raw) {
        this.fallback();
        return;
      }
      var context = host._context;
      var slotName = this.params.name;
      if (!slotName) {
        var self = this;
        var compileDefaultContent = function() {
          self.compile(extractFragment(raw.childNodes, raw, true), context, host);
        };
        if (!host._isCompiled) {
          host.$once('hook:compiled', compileDefaultContent);
        } else {
          compileDefaultContent();
        }
      } else {
        var selector = '[slot="' + slotName + '"]';
        var nodes = raw.querySelectorAll(selector);
        if (nodes.length) {
          content = extractFragment(nodes, raw);
          if (content.hasChildNodes()) {
            this.compile(content, context, host);
          } else {
            this.fallback();
          }
        } else {
          this.fallback();
        }
      }
    },
    fallback: function() {
      this.compile(_.extractContent(this.el, true), this.vm);
    },
    compile: function(content, context, host) {
      if (content && context) {
        var scope = host ? host._scope : this._scope;
        this.unlink = context.$compile(content, host, scope, this._frag);
      }
      if (content) {
        _.replace(this.el, content);
      } else {
        _.remove(this.el);
      }
    },
    unbind: function() {
      if (this.unlink) {
        this.unlink();
      }
    }
  };
  function extractFragment(nodes, parent, main) {
    var frag = document.createDocumentFragment();
    for (var i = 0,
        l = nodes.length; i < l; i++) {
      var node = nodes[i];
      if (main && !node.__v_selected) {
        append(node);
      } else if (!main && node.parentNode === parent) {
        node.__v_selected = true;
        append(node);
      }
    }
    return frag;
    function append(node) {
      if (_.isTemplate(node) && !node.hasAttribute('v-if') && !node.hasAttribute('v-for')) {
        node = templateParser.parse(node);
      }
      node = templateParser.clone(node);
      frag.appendChild(node);
    }
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3b", ["10", "1c", "19", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var vIf = req('1c');
    var FragmentFactory = req('19');
    module.exports = {
      priority: 1750,
      params: ['name'],
      paramWatchers: {name: function(value) {
          vIf.remove.call(this);
          if (value) {
            this.insert(value);
          }
        }},
      bind: function() {
        this.anchor = _.createAnchor('v-partial');
        _.replace(this.el, this.anchor);
        this.insert(this.params.name);
      },
      insert: function(id) {
        var partial = _.resolveAsset(this.vm.$options, 'partials', id);
        if (process.env.NODE_ENV !== 'production') {
          _.assertAsset(partial, 'partial', id);
        }
        if (partial) {
          this.factory = new FragmentFactory(this.vm, partial);
          vIf.insert.call(this);
        }
      },
      unbind: function() {
        if (this.frag) {
          this.frag.destroy();
        }
      }
    };
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3c", ["3a", "3b"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  exports.slot = req('3a');
  exports.partial = req('3b');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3d", ["10", "2d", "1b"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var Path = req('2d');
  var toArray = req('1b')._postProcess;
  exports.filterBy = function(arr, search, delimiter) {
    arr = toArray(arr);
    if (search == null) {
      return arr;
    }
    if (typeof search === 'function') {
      return arr.filter(search);
    }
    search = ('' + search).toLowerCase();
    var n = delimiter === 'in' ? 3 : 2;
    var keys = _.toArray(arguments, n).reduce(function(prev, cur) {
      return prev.concat(cur);
    }, []);
    var res = [];
    var item,
        key,
        val,
        j;
    for (var i = 0,
        l = arr.length; i < l; i++) {
      item = arr[i];
      val = (item && item.$value) || item;
      j = keys.length;
      if (j) {
        while (j--) {
          key = keys[j];
          if ((key === '$key' && contains(item.$key, search)) || contains(Path.get(val, key), search)) {
            res.push(item);
          }
        }
      } else {
        if (contains(item, search)) {
          res.push(item);
        }
      }
    }
    return res;
  };
  exports.orderBy = function(arr, sortKey, reverse) {
    arr = toArray(arr);
    if (!sortKey) {
      return arr;
    }
    var order = (reverse && reverse < 0) ? -1 : 1;
    return arr.slice().sort(function(a, b) {
      if (sortKey !== '$key') {
        if (_.isObject(a) && '$value' in a)
          a = a.$value;
        if (_.isObject(b) && '$value' in b)
          b = b.$value;
      }
      a = _.isObject(a) ? Path.get(a, sortKey) : a;
      b = _.isObject(b) ? Path.get(b, sortKey) : b;
      return a === b ? 0 : a > b ? order : -order;
    });
  };
  function contains(val, search) {
    var i;
    if (_.isPlainObject(val)) {
      var keys = Object.keys(val);
      i = keys.length;
      while (i--) {
        if (contains(val[keys[i]], search)) {
          return true;
        }
      }
    } else if (_.isArray(val)) {
      i = val.length;
      while (i--) {
        if (contains(val[i], search)) {
          return true;
        }
      }
    } else if (val != null) {
      return val.toString().toLowerCase().indexOf(search) > -1;
    }
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3e", ["10", "3d"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  exports.json = {
    read: function(value, indent) {
      return typeof value === 'string' ? value : JSON.stringify(value, null, Number(indent) || 2);
    },
    write: function(value) {
      try {
        return JSON.parse(value);
      } catch (e) {
        return value;
      }
    }
  };
  exports.capitalize = function(value) {
    if (!value && value !== 0)
      return '';
    value = value.toString();
    return value.charAt(0).toUpperCase() + value.slice(1);
  };
  exports.uppercase = function(value) {
    return (value || value === 0) ? value.toString().toUpperCase() : '';
  };
  exports.lowercase = function(value) {
    return (value || value === 0) ? value.toString().toLowerCase() : '';
  };
  var digitsRE = /(\d{3})(?=\d)/g;
  exports.currency = function(value, currency) {
    value = parseFloat(value);
    if (!isFinite(value) || (!value && value !== 0))
      return '';
    currency = currency != null ? currency : '$';
    var stringified = Math.abs(value).toFixed(2);
    var _int = stringified.slice(0, -3);
    var i = _int.length % 3;
    var head = i > 0 ? (_int.slice(0, i) + (_int.length > 3 ? ',' : '')) : '';
    var _float = stringified.slice(-3);
    var sign = value < 0 ? '-' : '';
    return currency + sign + head + _int.slice(i).replace(digitsRE, '$1,') + _float;
  };
  exports.pluralize = function(value) {
    var args = _.toArray(arguments, 1);
    return args.length > 1 ? (args[value % 10 - 1] || args[args.length - 1]) : (args[0] + (value === 1 ? '' : 's'));
  };
  exports.debounce = function(handler, delay) {
    if (!handler)
      return;
    if (!delay) {
      delay = 300;
    }
    return _.debounce(handler, delay);
  };
  _.extend(exports, req('3d'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3f", ["10"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var mergeOptions = req('10').mergeOptions;
  exports._init = function(options) {
    options = options || {};
    this.$el = null;
    this.$parent = options.parent;
    this.$root = this.$parent ? this.$parent.$root : this;
    this.$children = [];
    this.$refs = {};
    this.$els = {};
    this._watchers = [];
    this._directives = [];
    this._isVue = true;
    this._events = {};
    this._eventsCount = {};
    this._shouldPropagate = false;
    this._isFragment = false;
    this._fragment = this._fragmentStart = this._fragmentEnd = null;
    this._isCompiled = this._isDestroyed = this._isReady = this._isAttached = this._isBeingDestroyed = false;
    this._unlinkFn = null;
    this._context = options._context || this.$parent;
    this._scope = options._scope;
    this._frag = options._frag;
    if (this._frag) {
      this._frag.children.push(this);
    }
    if (this.$parent) {
      this.$parent.$children.push(this);
    }
    if (options._ref) {
      (this._scope || this._context).$refs[options._ref] = this;
    }
    options = this.$options = mergeOptions(this.constructor.options, options, this);
    this._data = {};
    this._callHook('init');
    this._initState();
    this._initEvents();
    this._callHook('created');
    if (options.el) {
      this.$mount(options.el);
    }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("40", ["10", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var inDoc = _.inDoc;
    var eventRE = /^v-on:|^@/;
    exports._initEvents = function() {
      var options = this.$options;
      if (options._asComponent) {
        registerComponentEvents(this, options.el);
      }
      registerCallbacks(this, '$on', options.events);
      registerCallbacks(this, '$watch', options.watch);
    };
    function registerComponentEvents(vm, el) {
      var attrs = el.attributes;
      var name,
          handler;
      for (var i = 0,
          l = attrs.length; i < l; i++) {
        name = attrs[i].name;
        if (eventRE.test(name)) {
          name = name.replace(eventRE, '');
          handler = (vm._scope || vm._context).$eval(attrs[i].value, true);
          vm.$on(name.replace(eventRE), handler);
        }
      }
    }
    function registerCallbacks(vm, action, hash) {
      if (!hash)
        return;
      var handlers,
          key,
          i,
          j;
      for (key in hash) {
        handlers = hash[key];
        if (_.isArray(handlers)) {
          for (i = 0, j = handlers.length; i < j; i++) {
            register(vm, action, key, handlers[i]);
          }
        } else {
          register(vm, action, key, handlers);
        }
      }
    }
    function register(vm, action, key, handler, options) {
      var type = typeof handler;
      if (type === 'function') {
        vm[action](key, handler, options);
      } else if (type === 'string') {
        var methods = vm.$options.methods;
        var method = methods && methods[handler];
        if (method) {
          vm[action](key, method, options);
        } else {
          process.env.NODE_ENV !== 'production' && _.warn('Unknown method: "' + handler + '" when ' + 'registering callback for ' + action + ': "' + key + '".');
        }
      } else if (handler && type === 'object') {
        register(vm, action, key, handler.handler, handler);
      }
    }
    exports._initDOMHooks = function() {
      this.$on('hook:attached', onAttached);
      this.$on('hook:detached', onDetached);
    };
    function onAttached() {
      if (!this._isAttached) {
        this._isAttached = true;
        this.$children.forEach(callAttach);
      }
    }
    function callAttach(child) {
      if (!child._isAttached && inDoc(child.$el)) {
        child._callHook('attached');
      }
    }
    function onDetached() {
      if (this._isAttached) {
        this._isAttached = false;
        this.$children.forEach(callDetach);
      }
    }
    function callDetach(child) {
      if (child._isAttached && !inDoc(child.$el)) {
        child._callHook('detached');
      }
    }
    exports._callHook = function(hook) {
      var handlers = this.$options[hook];
      if (handlers) {
        for (var i = 0,
            j = handlers.length; i < j; i++) {
          handlers[i].call(this);
        }
      }
      this.$emit('hook:' + hook);
    };
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("41", ["10"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var arrayProto = Array.prototype;
  var arrayMethods = Object.create(arrayProto);
  ;
  ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse'].forEach(function(method) {
    var original = arrayProto[method];
    _.define(arrayMethods, method, function mutator() {
      var i = arguments.length;
      var args = new Array(i);
      while (i--) {
        args[i] = arguments[i];
      }
      var result = original.apply(this, args);
      var ob = this.__ob__;
      var inserted,
          removed;
      switch (method) {
        case 'push':
          inserted = args;
          break;
        case 'unshift':
          inserted = args;
          break;
        case 'splice':
          inserted = args.slice(2);
          removed = result;
          break;
        case 'pop':
        case 'shift':
          removed = [result];
          break;
      }
      if (inserted)
        ob.observeArray(inserted);
      if (removed)
        ob.unobserveArray(removed);
      ob.notify();
      return result;
    });
  });
  _.define(arrayProto, '$set', function $set(index, val) {
    if (index >= this.length) {
      this.length = index + 1;
    }
    return this.splice(index, 1, val)[0];
  });
  _.define(arrayProto, '$remove', function $remove(item) {
    if (!this.length)
      return;
    var index = _.indexOf(this, item);
    if (index > -1) {
      return this.splice(index, 1);
    }
  });
  module.exports = arrayMethods;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("42", ["10", "2c", "41"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var Dep = req('2c');
  var arrayMethods = req('41');
  var arrayKeys = Object.getOwnPropertyNames(arrayMethods);
  function Observer(value) {
    this.value = value;
    this.dep = new Dep();
    _.define(value, '__ob__', this);
    if (_.isArray(value)) {
      var augment = _.hasProto ? protoAugment : copyAugment;
      augment(value, arrayMethods, arrayKeys);
      this.observeArray(value);
    } else {
      this.walk(value);
    }
  }
  Observer.create = function(value, vm) {
    if (!value || typeof value !== 'object') {
      return;
    }
    var ob;
    if (value.hasOwnProperty('__ob__') && value.__ob__ instanceof Observer) {
      ob = value.__ob__;
    } else if ((_.isArray(value) || _.isPlainObject(value)) && !Object.isFrozen(value) && !value._isVue) {
      ob = new Observer(value);
    }
    if (ob && vm) {
      ob.addVm(vm);
    }
    return ob;
  };
  Observer.prototype.walk = function(obj) {
    var keys = Object.keys(obj);
    var i = keys.length;
    while (i--) {
      this.convert(keys[i], obj[keys[i]]);
    }
  };
  Observer.prototype.observeArray = function(items) {
    var i = items.length;
    while (i--) {
      var ob = Observer.create(items[i]);
      if (ob) {
        (ob.parents || (ob.parents = [])).push(this);
      }
    }
  };
  Observer.prototype.unobserveArray = function(items) {
    var i = items.length;
    while (i--) {
      var ob = items[i] && items[i].__ob__;
      if (ob) {
        ob.parents.$remove(this);
      }
    }
  };
  Observer.prototype.notify = function() {
    this.dep.notify();
    var parents = this.parents;
    if (parents) {
      var i = parents.length;
      while (i--) {
        parents[i].notify();
      }
    }
  };
  Observer.prototype.convert = function(key, val) {
    defineReactive(this.value, key, val);
  };
  Observer.prototype.addVm = function(vm) {
    (this.vms || (this.vms = [])).push(vm);
  };
  Observer.prototype.removeVm = function(vm) {
    this.vms.$remove(vm);
  };
  function protoAugment(target, src) {
    target.__proto__ = src;
  }
  function copyAugment(target, src, keys) {
    var i = keys.length;
    var key;
    while (i--) {
      key = keys[i];
      _.define(target, key, src[key]);
    }
  }
  function defineReactive(obj, key, val) {
    var dep = new Dep();
    var childOb = Observer.create(val);
    Object.defineProperty(obj, key, {
      enumerable: true,
      configurable: true,
      get: function metaGetter() {
        if (Dep.target) {
          dep.depend();
          if (childOb) {
            childOb.dep.depend();
          }
        }
        return val;
      },
      set: function metaSetter(newVal) {
        if (newVal === val)
          return;
        val = newVal;
        childOb = Observer.create(newVal);
        dep.notify();
      }
    });
  }
  _.defineReactive = defineReactive;
  module.exports = Observer;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("43", ["10", "1a", "42", "2c", "30", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var compiler = req('1a');
    var Observer = req('42');
    var Dep = req('2c');
    var Watcher = req('30');
    exports._initState = function() {
      this._initProps();
      this._initMeta();
      this._initMethods();
      this._initData();
      this._initComputed();
    };
    exports._initProps = function() {
      var options = this.$options;
      var el = options.el;
      var props = options.props;
      if (props && !el) {
        process.env.NODE_ENV !== 'production' && _.warn('Props will not be compiled if no `el` option is ' + 'provided at instantiation.');
      }
      el = options.el = _.query(el);
      this._propsUnlinkFn = el && el.nodeType === 1 && props ? compiler.compileAndLinkProps(this, el, props, this._scope) : null;
    };
    exports._initData = function() {
      var propsData = this._data;
      var optionsDataFn = this.$options.data;
      var optionsData = optionsDataFn && optionsDataFn();
      if (optionsData) {
        this._data = optionsData;
        for (var prop in propsData) {
          if (process.env.NODE_ENV !== 'production' && optionsData.hasOwnProperty(prop)) {
            _.warn('Data field "' + prop + '" is already defined ' + 'as a prop. Use prop default value instead.');
          }
          if (this._props[prop].raw !== null || !optionsData.hasOwnProperty(prop)) {
            _.set(optionsData, prop, propsData[prop]);
          }
        }
      }
      var data = this._data;
      var keys = Object.keys(data);
      var i,
          key;
      i = keys.length;
      while (i--) {
        key = keys[i];
        this._proxy(key);
      }
      Observer.create(data, this);
    };
    exports._setData = function(newData) {
      newData = newData || {};
      var oldData = this._data;
      this._data = newData;
      var keys,
          key,
          i;
      keys = Object.keys(oldData);
      i = keys.length;
      while (i--) {
        key = keys[i];
        if (!(key in newData)) {
          this._unproxy(key);
        }
      }
      keys = Object.keys(newData);
      i = keys.length;
      while (i--) {
        key = keys[i];
        if (!this.hasOwnProperty(key)) {
          this._proxy(key);
        }
      }
      oldData.__ob__.removeVm(this);
      Observer.create(newData, this);
      this._digest();
    };
    exports._proxy = function(key) {
      if (!_.isReserved(key)) {
        var self = this;
        Object.defineProperty(self, key, {
          configurable: true,
          enumerable: true,
          get: function proxyGetter() {
            return self._data[key];
          },
          set: function proxySetter(val) {
            self._data[key] = val;
          }
        });
      }
    };
    exports._unproxy = function(key) {
      if (!_.isReserved(key)) {
        delete this[key];
      }
    };
    exports._digest = function() {
      for (var i = 0,
          l = this._watchers.length; i < l; i++) {
        this._watchers[i].update(true);
      }
    };
    function noop() {}
    exports._initComputed = function() {
      var computed = this.$options.computed;
      if (computed) {
        for (var key in computed) {
          var userDef = computed[key];
          var def = {
            enumerable: true,
            configurable: true
          };
          if (typeof userDef === 'function') {
            def.get = makeComputedGetter(userDef, this);
            def.set = noop;
          } else {
            def.get = userDef.get ? userDef.cache !== false ? makeComputedGetter(userDef.get, this) : _.bind(userDef.get, this) : noop;
            def.set = userDef.set ? _.bind(userDef.set, this) : noop;
          }
          Object.defineProperty(this, key, def);
        }
      }
    };
    function makeComputedGetter(getter, owner) {
      var watcher = new Watcher(owner, getter, null, {lazy: true});
      return function computedGetter() {
        if (watcher.dirty) {
          watcher.evaluate();
        }
        if (Dep.target) {
          watcher.depend();
        }
        return watcher.value;
      };
    }
    exports._initMethods = function() {
      var methods = this.$options.methods;
      if (methods) {
        for (var key in methods) {
          this[key] = _.bind(methods[key], this);
        }
      }
    };
    exports._initMeta = function() {
      var metas = this.$options._meta;
      if (metas) {
        for (var key in metas) {
          _.defineReactive(this, key, metas[key]);
        }
      }
    };
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("44", ["10", "30", "2e", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var Watcher = req('30');
    var expParser = req('2e');
    function noop() {}
    function Directive(descriptor, vm, el, host, scope, frag) {
      this.vm = vm;
      this.el = el;
      this.descriptor = descriptor;
      this.name = descriptor.name;
      this.expression = descriptor.expression;
      this.arg = descriptor.arg;
      this.modifiers = descriptor.modifiers;
      this.filters = descriptor.filters;
      this.literal = this.modifiers && this.modifiers.literal;
      this._locked = false;
      this._bound = false;
      this._listeners = null;
      this._host = host;
      this._scope = scope;
      this._frag = frag;
    }
    Directive.prototype._bind = function() {
      var name = this.name;
      var descriptor = this.descriptor;
      if ((name !== 'cloak' || this.vm._isCompiled) && this.el && this.el.removeAttribute) {
        var attr = descriptor.attr || ('v-' + name);
        this.el.removeAttribute(attr);
      }
      var def = descriptor.def;
      if (typeof def === 'function') {
        this.update = def;
      } else {
        _.extend(this, def);
      }
      this._setupParams();
      if (this.bind) {
        this.bind();
      }
      if (this.literal) {
        this.update && this.update(descriptor.raw);
      } else if ((this.expression || this.modifiers) && (this.update || this.twoWay) && !this._checkStatement()) {
        var dir = this;
        if (this.update) {
          this._update = function(val, oldVal) {
            if (!dir._locked) {
              dir.update(val, oldVal);
            }
          };
        } else {
          this._update = noop;
        }
        var preProcess = this._preProcess ? _.bind(this._preProcess, this) : null;
        var postProcess = this._postProcess ? _.bind(this._postProcess, this) : null;
        var watcher = this._watcher = new Watcher(this.vm, this.expression, this._update, {
          filters: this.filters,
          twoWay: this.twoWay,
          deep: this.deep,
          preProcess: preProcess,
          postProcess: postProcess,
          scope: this._scope
        });
        if (this.afterBind) {
          this.afterBind();
        } else if (this.update) {
          this.update(watcher.value);
        }
      }
      this._bound = true;
    };
    Directive.prototype._setupParams = function() {
      if (!this.params) {
        return;
      }
      var params = this.params;
      this.params = Object.create(null);
      var i = params.length;
      var key,
          val,
          mappedKey;
      while (i--) {
        key = params[i];
        mappedKey = _.camelize(key);
        val = _.attr(this.el, key);
        if (val != null) {
          this.params[mappedKey] = val === '' ? true : val;
        } else {
          val = _.getBindAttr(this.el, key);
          if (val != null) {
            this._setupParamWatcher(mappedKey, val);
          }
        }
      }
    };
    Directive.prototype._setupParamWatcher = function(key, expression) {
      var self = this;
      var called = false;
      var unwatch = (this._scope || this.vm).$watch(expression, function(val, oldVal) {
        self.params[key] = val;
        if (called) {
          var cb = self.paramWatchers && self.paramWatchers[key];
          if (cb) {
            cb.call(self, val, oldVal);
          }
        } else {
          called = true;
        }
      }, {immediate: true});
      ;
      (this._paramUnwatchFns || (this._paramUnwatchFns = [])).push(unwatch);
    };
    Directive.prototype._checkStatement = function() {
      var expression = this.expression;
      if (expression && this.acceptStatement && !expParser.isSimplePath(expression)) {
        var fn = expParser.parse(expression).get;
        var scope = this._scope || this.vm;
        var handler = function() {
          fn.call(scope, scope);
        };
        if (this.filters) {
          handler = this.vm._applyFilters(handler, null, this.filters);
        }
        this.update(handler);
        return true;
      }
    };
    Directive.prototype.set = function(value) {
      if (this.twoWay) {
        this._withLock(function() {
          this._watcher.set(value);
        });
      } else if (process.env.NODE_ENV !== 'production') {
        _.warn('Directive.set() can only be used inside twoWay' + 'directives.');
      }
    };
    Directive.prototype._withLock = function(fn) {
      var self = this;
      self._locked = true;
      fn.call(self);
      _.nextTick(function() {
        self._locked = false;
      });
    };
    Directive.prototype.on = function(event, handler) {
      _.on(this.el, event, handler);
      ;
      (this._listeners || (this._listeners = [])).push([event, handler]);
    };
    Directive.prototype._teardown = function() {
      if (this._bound) {
        this._bound = false;
        if (this.unbind) {
          this.unbind();
        }
        if (this._watcher) {
          this._watcher.teardown();
        }
        var listeners = this._listeners;
        var i;
        if (listeners) {
          i = listeners.length;
          while (i--) {
            _.off(this.el, listeners[i][0], listeners[i][1]);
          }
        }
        var unwatchFns = this._paramUnwatchFns;
        if (unwatchFns) {
          i = unwatchFns.length;
          while (i--) {
            unwatchFns[i]();
          }
        }
        this.vm = this.el = this._watcher = this._listeners = null;
      }
    };
    module.exports = Directive;
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("45", ["10", "44", "1a"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var Directive = req('44');
  var compiler = req('1a');
  exports._compile = function(el) {
    var options = this.$options;
    var original = el;
    el = compiler.transclude(el, options);
    this._initElement(el);
    var contextOptions = this._context && this._context.$options;
    var rootLinker = compiler.compileRoot(el, options, contextOptions);
    var contentLinkFn;
    var ctor = this.constructor;
    if (options._linkerCachable) {
      contentLinkFn = ctor.linker;
      if (!contentLinkFn) {
        contentLinkFn = ctor.linker = compiler.compile(el, options);
      }
    }
    var rootUnlinkFn = rootLinker(this, el, this._scope);
    var contentUnlinkFn = contentLinkFn ? contentLinkFn(this, el) : compiler.compile(el, options)(this, el);
    this._unlinkFn = function() {
      rootUnlinkFn();
      contentUnlinkFn(true);
    };
    if (options.replace) {
      _.replace(original, el);
    }
    this._isCompiled = true;
    this._callHook('compiled');
    return el;
  };
  exports._initElement = function(el) {
    if (el instanceof DocumentFragment) {
      this._isFragment = true;
      this.$el = this._fragmentStart = el.firstChild;
      this._fragmentEnd = el.lastChild;
      if (this._fragmentStart.nodeType === 3) {
        this._fragmentStart.data = this._fragmentEnd.data = '';
      }
      this._fragment = el;
    } else {
      this.$el = el;
    }
    this.$el.__vue__ = this;
    this._callHook('beforeCompile');
  };
  exports._bindDir = function(descriptor, node, host, scope, frag) {
    this._directives.push(new Directive(descriptor, this, node, host, scope, frag));
  };
  exports._destroy = function(remove, deferCleanup) {
    if (this._isBeingDestroyed) {
      return;
    }
    this._callHook('beforeDestroy');
    this._isBeingDestroyed = true;
    var i;
    var parent = this.$parent;
    if (parent && !parent._isBeingDestroyed) {
      parent.$children.$remove(this);
      var ref = this.$options._ref;
      if (ref) {
        var scope = this._scope || this._context;
        if (scope.$refs[ref] === this) {
          scope.$refs[ref] = null;
        }
      }
    }
    if (this._frag) {
      this._frag.children.$remove(this);
    }
    i = this.$children.length;
    while (i--) {
      this.$children[i].$destroy();
    }
    if (this._propsUnlinkFn) {
      this._propsUnlinkFn();
    }
    if (this._unlinkFn) {
      this._unlinkFn();
    }
    i = this._watchers.length;
    while (i--) {
      this._watchers[i].teardown();
    }
    if (this.$el) {
      this.$el.__vue__ = null;
    }
    var self = this;
    if (remove && this.$el) {
      this.$remove(function() {
        self._cleanup();
      });
    } else if (!deferCleanup) {
      this._cleanup();
    }
  };
  exports._cleanup = function() {
    if (this._data.__ob__) {
      this._data.__ob__.removeVm(this);
    }
    this.$el = this.$parent = this.$root = this.$children = this._watchers = this._context = this._scope = this._directives = null;
    this._isDestroyed = true;
    this._callHook('destroyed');
    this.$off();
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("46", ["10", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    exports._applyFilters = function(value, oldValue, filters, write) {
      var filter,
          fn,
          args,
          arg,
          offset,
          i,
          l,
          j,
          k;
      for (i = 0, l = filters.length; i < l; i++) {
        filter = filters[i];
        fn = _.resolveAsset(this.$options, 'filters', filter.name);
        if (process.env.NODE_ENV !== 'production') {
          _.assertAsset(fn, 'filter', filter.name);
        }
        if (!fn)
          continue;
        fn = write ? fn.write : (fn.read || fn);
        if (typeof fn !== 'function')
          continue;
        args = write ? [value, oldValue] : [value];
        offset = write ? 2 : 1;
        if (filter.args) {
          for (j = 0, k = filter.args.length; j < k; j++) {
            arg = filter.args[j];
            args[j + offset] = arg.dynamic ? this.$get(arg.value) : arg.value;
          }
        }
        value = fn.apply(this, args);
      }
      return value;
    };
    exports._resolveComponent = function(id, cb) {
      var factory = _.resolveAsset(this.$options, 'components', id);
      if (process.env.NODE_ENV !== 'production') {
        _.assertAsset(factory, 'component', id);
      }
      if (!factory) {
        return;
      }
      if (!factory.options) {
        if (factory.resolved) {
          cb(factory.resolved);
        } else if (factory.requested) {
          factory.pendingCallbacks.push(cb);
        } else {
          factory.requested = true;
          var cbs = factory.pendingCallbacks = [cb];
          factory(function resolve(res) {
            if (_.isPlainObject(res)) {
              res = _.Vue.extend(res);
            }
            factory.resolved = res;
            for (var i = 0,
                l = cbs.length; i < l; i++) {
              cbs[i](res);
            }
          }, function reject(reason) {
            process.env.NODE_ENV !== 'production' && _.warn('Failed to resolve async component: ' + id + '. ' + (reason ? '\nReason: ' + reason : ''));
          });
        }
      } else {
        cb(factory);
      }
    };
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("47", ["10", "30", "2d", "11", "f", "2e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var Watcher = req('30');
  var Path = req('2d');
  var textParser = req('11');
  var dirParser = req('f');
  var expParser = req('2e');
  var filterRE = /[^|]\|[^|]/;
  exports.$get = function(exp, asStatement) {
    var res = expParser.parse(exp);
    if (res) {
      if (asStatement && !expParser.isSimplePath(exp)) {
        var self = this;
        return function statementHandler() {
          res.get.call(self, self);
        };
      } else {
        try {
          return res.get.call(this, this);
        } catch (e) {}
      }
    }
  };
  exports.$set = function(exp, val) {
    var res = expParser.parse(exp, true);
    if (res && res.set) {
      res.set.call(this, this, val);
    }
  };
  exports.$delete = function(key) {
    _.delete(this._data, key);
  };
  exports.$watch = function(expOrFn, cb, options) {
    var vm = this;
    var parsed;
    if (typeof expOrFn === 'string') {
      parsed = dirParser.parse(expOrFn);
      expOrFn = parsed.expression;
    }
    var watcher = new Watcher(vm, expOrFn, cb, {
      deep: options && options.deep,
      filters: parsed && parsed.filters
    });
    if (options && options.immediate) {
      cb.call(vm, watcher.value);
    }
    return function unwatchFn() {
      watcher.teardown();
    };
  };
  exports.$eval = function(text, asStatement) {
    if (filterRE.test(text)) {
      var dir = dirParser.parse(text);
      var val = this.$get(dir.expression, asStatement);
      return dir.filters ? this._applyFilters(val, null, dir.filters) : val;
    } else {
      return this.$get(text, asStatement);
    }
  };
  exports.$interpolate = function(text) {
    var tokens = textParser.parse(text);
    var vm = this;
    if (tokens) {
      if (tokens.length === 1) {
        return vm.$eval(tokens[0].value) + '';
      } else {
        return tokens.map(function(token) {
          return token.tag ? vm.$eval(token.value) : token.value;
        }).join('');
      }
    } else {
      return text;
    }
  };
  exports.$log = function(path) {
    var data = path ? Path.get(this._data, path) : this._data;
    if (data) {
      data = clean(data);
    }
    if (!path) {
      for (var key in this.$options.computed) {
        data[key] = clean(this[key]);
      }
    }
    console.log(data);
  };
  function clean(obj) {
    return JSON.parse(JSON.stringify(obj));
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("48", ["10", "13"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var transition = req('13');
  exports.$nextTick = function(fn) {
    _.nextTick(fn, this);
  };
  exports.$appendTo = function(target, cb, withTransition) {
    return insert(this, target, cb, withTransition, append, transition.append);
  };
  exports.$prependTo = function(target, cb, withTransition) {
    target = query(target);
    if (target.hasChildNodes()) {
      this.$before(target.firstChild, cb, withTransition);
    } else {
      this.$appendTo(target, cb, withTransition);
    }
    return this;
  };
  exports.$before = function(target, cb, withTransition) {
    return insert(this, target, cb, withTransition, before, transition.before);
  };
  exports.$after = function(target, cb, withTransition) {
    target = query(target);
    if (target.nextSibling) {
      this.$before(target.nextSibling, cb, withTransition);
    } else {
      this.$appendTo(target.parentNode, cb, withTransition);
    }
    return this;
  };
  exports.$remove = function(cb, withTransition) {
    if (!this.$el.parentNode) {
      return cb && cb();
    }
    var inDoc = this._isAttached && _.inDoc(this.$el);
    if (!inDoc)
      withTransition = false;
    var self = this;
    var realCb = function() {
      if (inDoc)
        self._callHook('detached');
      if (cb)
        cb();
    };
    if (this._isFragment) {
      _.removeNodeRange(this._fragmentStart, this._fragmentEnd, this, this._fragment, realCb);
    } else {
      var op = withTransition === false ? remove : transition.remove;
      op(this.$el, this, realCb);
    }
    return this;
  };
  function insert(vm, target, cb, withTransition, op1, op2) {
    target = query(target);
    var targetIsDetached = !_.inDoc(target);
    var op = withTransition === false || targetIsDetached ? op1 : op2;
    var shouldCallHook = !targetIsDetached && !vm._isAttached && !_.inDoc(vm.$el);
    if (vm._isFragment) {
      _.mapNodeRange(vm._fragmentStart, vm._fragmentEnd, function(node) {
        op(node, target, vm);
      });
      cb && cb();
    } else {
      op(vm.$el, target, vm, cb);
    }
    if (shouldCallHook) {
      vm._callHook('attached');
    }
    return vm;
  }
  function query(el) {
    return typeof el === 'string' ? document.querySelector(el) : el;
  }
  function append(el, target, vm, cb) {
    target.appendChild(el);
    if (cb)
      cb();
  }
  function before(el, target, vm, cb) {
    _.before(el, target);
    if (cb)
      cb();
  }
  function remove(el, vm, cb) {
    _.remove(el);
    if (cb)
      cb();
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("49", ["10"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  exports.$on = function(event, fn) {
    (this._events[event] || (this._events[event] = [])).push(fn);
    modifyListenerCount(this, event, 1);
    return this;
  };
  exports.$once = function(event, fn) {
    var self = this;
    function on() {
      self.$off(event, on);
      fn.apply(this, arguments);
    }
    on.fn = fn;
    this.$on(event, on);
    return this;
  };
  exports.$off = function(event, fn) {
    var cbs;
    if (!arguments.length) {
      if (this.$parent) {
        for (event in this._events) {
          cbs = this._events[event];
          if (cbs) {
            modifyListenerCount(this, event, -cbs.length);
          }
        }
      }
      this._events = {};
      return this;
    }
    cbs = this._events[event];
    if (!cbs) {
      return this;
    }
    if (arguments.length === 1) {
      modifyListenerCount(this, event, -cbs.length);
      this._events[event] = null;
      return this;
    }
    var cb;
    var i = cbs.length;
    while (i--) {
      cb = cbs[i];
      if (cb === fn || cb.fn === fn) {
        modifyListenerCount(this, event, -1);
        cbs.splice(i, 1);
        break;
      }
    }
    return this;
  };
  exports.$emit = function(event) {
    var cbs = this._events[event];
    this._shouldPropagate = !cbs;
    if (cbs) {
      cbs = cbs.length > 1 ? _.toArray(cbs) : cbs;
      var args = _.toArray(arguments, 1);
      for (var i = 0,
          l = cbs.length; i < l; i++) {
        var res = cbs[i].apply(this, args);
        if (res === true) {
          this._shouldPropagate = true;
        }
      }
    }
    return this;
  };
  exports.$broadcast = function(event) {
    if (!this._eventsCount[event])
      return;
    var children = this.$children;
    for (var i = 0,
        l = children.length; i < l; i++) {
      var child = children[i];
      child.$emit.apply(child, arguments);
      if (child._shouldPropagate) {
        child.$broadcast.apply(child, arguments);
      }
    }
    return this;
  };
  exports.$dispatch = function() {
    this.$emit.apply(this, arguments);
    var parent = this.$parent;
    while (parent) {
      parent.$emit.apply(parent, arguments);
      parent = parent._shouldPropagate ? parent.$parent : null;
    }
    return this;
  };
  var hookRE = /^hook:/;
  function modifyListenerCount(vm, event, count) {
    var parent = vm.$parent;
    if (!parent || !count || hookRE.test(event))
      return;
    while (parent) {
      parent._eventsCount[event] = (parent._eventsCount[event] || 0) + count;
      parent = parent.$parent;
    }
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4a", ["10", "1a", "e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var _ = req('10');
    var compiler = req('1a');
    exports.$mount = function(el) {
      if (this._isCompiled) {
        process.env.NODE_ENV !== 'production' && _.warn('$mount() should be called only once.');
        return;
      }
      el = _.query(el);
      if (!el) {
        el = document.createElement('div');
      }
      this._compile(el);
      this._initDOMHooks();
      if (_.inDoc(this.$el)) {
        this._callHook('attached');
        ready.call(this);
      } else {
        this.$once('hook:attached', ready);
      }
      return this;
    };
    function ready() {
      this._isAttached = true;
      this._isReady = true;
      this._callHook('ready');
    }
    exports.$destroy = function(remove, deferCleanup) {
      this._destroy(remove, deferCleanup);
    };
    exports.$compile = function(el, host, scope, frag) {
      return compiler.compile(el, this.$options, true)(this, el, host, scope, frag);
    };
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4b", ["10", "39", "28", "3c", "3e", "3f", "40", "43", "45", "46", "47", "48", "49", "4a"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var _ = req('10');
  var extend = _.extend;
  function Vue(options) {
    this._init(options);
  }
  extend(Vue, req('39'));
  Vue.options = {
    replace: true,
    directives: req('28'),
    elementDirectives: req('3c'),
    filters: req('3e'),
    transitions: {},
    components: {},
    partials: {}
  };
  var p = Vue.prototype;
  Object.defineProperty(p, '$data', {
    get: function() {
      return this._data;
    },
    set: function(newData) {
      if (newData !== this._data) {
        this._setData(newData);
      }
    }
  });
  extend(p, req('3f'));
  extend(p, req('40'));
  extend(p, req('43'));
  extend(p, req('45'));
  extend(p, req('46'));
  extend(p, req('47'));
  extend(p, req('48'));
  extend(p, req('49'));
  extend(p, req('4a'));
  Vue.version = '1.0.0-rc.2';
  module.exports = _.Vue = Vue;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4c", ["4b"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = req('4b');
  global.define = __define;
  return module.exports;
});

$__System.register("4d", [], function() { return { setters: [], execute: function() {} } });

$__System.registerDynamic("4e", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = "<div class=\"WeatherPanel\">\n\t<ul>\n\t\t<li v-for=\"weather in weather_list\">\n\t\t\t<a v-on:click=\"open(weather)\">\n\t\t\t\t<span>{{ weather.val.location }}</span>\n\t\t\t</a>\n\t\t</li>\n\t</ul>\n\t<div v-if=\"weather_item\">\n\t\t<h1>\n\t\t\t<span v-text=\"weather_item.title\"></span>\n\t\t\t<span class=\"weather-icon {{weather_item.icon_class}}\"></span>\n\t\t\t<br/>\n\t\t\t<small v-text=\"weather_item.icon\"></small>\n\t\t\t<small v-text=\"weather_item.temperature\"></small>\n\t\t</h1>\n\t</div>\n</div>";
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4f", [], false, function(__require, __exports, __module) {
  var _retrieveGlobal = $__System.get("@@global-helpers").prepareGlobal(__module.id, null, null);
  (function() {
    (function() {
      var g,
          aa = this;
      function n(a) {
        return void 0 !== a;
      }
      function ba() {}
      function ca(a) {
        a.ub = function() {
          return a.uf ? a.uf : a.uf = new a;
        };
      }
      function da(a) {
        var b = typeof a;
        if ("object" == b)
          if (a) {
            if (a instanceof Array)
              return "array";
            if (a instanceof Object)
              return b;
            var c = Object.prototype.toString.call(a);
            if ("[object Window]" == c)
              return "object";
            if ("[object Array]" == c || "number" == typeof a.length && "undefined" != typeof a.splice && "undefined" != typeof a.propertyIsEnumerable && !a.propertyIsEnumerable("splice"))
              return "array";
            if ("[object Function]" == c || "undefined" != typeof a.call && "undefined" != typeof a.propertyIsEnumerable && !a.propertyIsEnumerable("call"))
              return "function";
          } else
            return "null";
        else if ("function" == b && "undefined" == typeof a.call)
          return "object";
        return b;
      }
      function ea(a) {
        return "array" == da(a);
      }
      function fa(a) {
        var b = da(a);
        return "array" == b || "object" == b && "number" == typeof a.length;
      }
      function p(a) {
        return "string" == typeof a;
      }
      function ga(a) {
        return "number" == typeof a;
      }
      function ha(a) {
        return "function" == da(a);
      }
      function ia(a) {
        var b = typeof a;
        return "object" == b && null != a || "function" == b;
      }
      function ja(a, b, c) {
        return a.call.apply(a.bind, arguments);
      }
      function ka(a, b, c) {
        if (!a)
          throw Error();
        if (2 < arguments.length) {
          var d = Array.prototype.slice.call(arguments, 2);
          return function() {
            var c = Array.prototype.slice.call(arguments);
            Array.prototype.unshift.apply(c, d);
            return a.apply(b, c);
          };
        }
        return function() {
          return a.apply(b, arguments);
        };
      }
      function q(a, b, c) {
        q = Function.prototype.bind && -1 != Function.prototype.bind.toString().indexOf("native code") ? ja : ka;
        return q.apply(null, arguments);
      }
      var la = Date.now || function() {
        return +new Date;
      };
      function ma(a, b) {
        function c() {}
        c.prototype = b.prototype;
        a.bh = b.prototype;
        a.prototype = new c;
        a.prototype.constructor = a;
        a.Yg = function(a, c, f) {
          for (var h = Array(arguments.length - 2),
              k = 2; k < arguments.length; k++)
            h[k - 2] = arguments[k];
          return b.prototype[c].apply(a, h);
        };
      }
      ;
      function r(a, b) {
        for (var c in a)
          b.call(void 0, a[c], c, a);
      }
      function na(a, b) {
        var c = {},
            d;
        for (d in a)
          c[d] = b.call(void 0, a[d], d, a);
        return c;
      }
      function oa(a, b) {
        for (var c in a)
          if (!b.call(void 0, a[c], c, a))
            return !1;
        return !0;
      }
      function pa(a) {
        var b = 0,
            c;
        for (c in a)
          b++;
        return b;
      }
      function qa(a) {
        for (var b in a)
          return b;
      }
      function ra(a) {
        var b = [],
            c = 0,
            d;
        for (d in a)
          b[c++] = a[d];
        return b;
      }
      function sa(a) {
        var b = [],
            c = 0,
            d;
        for (d in a)
          b[c++] = d;
        return b;
      }
      function ta(a, b) {
        for (var c in a)
          if (a[c] == b)
            return !0;
        return !1;
      }
      function ua(a, b, c) {
        for (var d in a)
          if (b.call(c, a[d], d, a))
            return d;
      }
      function va(a, b) {
        var c = ua(a, b, void 0);
        return c && a[c];
      }
      function wa(a) {
        for (var b in a)
          return !1;
        return !0;
      }
      function xa(a) {
        var b = {},
            c;
        for (c in a)
          b[c] = a[c];
        return b;
      }
      var ya = "constructor hasOwnProperty isPrototypeOf propertyIsEnumerable toLocaleString toString valueOf".split(" ");
      function za(a, b) {
        for (var c,
            d,
            e = 1; e < arguments.length; e++) {
          d = arguments[e];
          for (c in d)
            a[c] = d[c];
          for (var f = 0; f < ya.length; f++)
            c = ya[f], Object.prototype.hasOwnProperty.call(d, c) && (a[c] = d[c]);
        }
      }
      ;
      function Aa(a) {
        a = String(a);
        if (/^\s*$/.test(a) ? 0 : /^[\],:{}\s\u2028\u2029]*$/.test(a.replace(/\\["\\\/bfnrtu]/g, "@").replace(/"[^"\\\n\r\u2028\u2029\x00-\x08\x0a-\x1f]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, "]").replace(/(?:^|:|,)(?:[\s\u2028\u2029]*\[)+/g, "")))
          try {
            return eval("(" + a + ")");
          } catch (b) {}
        throw Error("Invalid JSON string: " + a);
      }
      function Ba() {
        this.Sd = void 0;
      }
      function Ca(a, b, c) {
        switch (typeof b) {
          case "string":
            Da(b, c);
            break;
          case "number":
            c.push(isFinite(b) && !isNaN(b) ? b : "null");
            break;
          case "boolean":
            c.push(b);
            break;
          case "undefined":
            c.push("null");
            break;
          case "object":
            if (null == b) {
              c.push("null");
              break;
            }
            if (ea(b)) {
              var d = b.length;
              c.push("[");
              for (var e = "",
                  f = 0; f < d; f++)
                c.push(e), e = b[f], Ca(a, a.Sd ? a.Sd.call(b, String(f), e) : e, c), e = ",";
              c.push("]");
              break;
            }
            c.push("{");
            d = "";
            for (f in b)
              Object.prototype.hasOwnProperty.call(b, f) && (e = b[f], "function" != typeof e && (c.push(d), Da(f, c), c.push(":"), Ca(a, a.Sd ? a.Sd.call(b, f, e) : e, c), d = ","));
            c.push("}");
            break;
          case "function":
            break;
          default:
            throw Error("Unknown type: " + typeof b);
        }
      }
      var Ea = {
        '"': '\\"',
        "\\": "\\\\",
        "/": "\\/",
        "\b": "\\b",
        "\f": "\\f",
        "\n": "\\n",
        "\r": "\\r",
        "\t": "\\t",
        "\x0B": "\\u000b"
      },
          Fa = /\uffff/.test("\uffff") ? /[\\\"\x00-\x1f\x7f-\uffff]/g : /[\\\"\x00-\x1f\x7f-\xff]/g;
      function Da(a, b) {
        b.push('"', a.replace(Fa, function(a) {
          if (a in Ea)
            return Ea[a];
          var b = a.charCodeAt(0),
              e = "\\u";
          16 > b ? e += "000" : 256 > b ? e += "00" : 4096 > b && (e += "0");
          return Ea[a] = e + b.toString(16);
        }), '"');
      }
      ;
      function Ga() {
        return Math.floor(2147483648 * Math.random()).toString(36) + Math.abs(Math.floor(2147483648 * Math.random()) ^ la()).toString(36);
      }
      ;
      var Ha;
      a: {
        var Ia = aa.navigator;
        if (Ia) {
          var Ja = Ia.userAgent;
          if (Ja) {
            Ha = Ja;
            break a;
          }
        }
        Ha = "";
      }
      ;
      function Ka() {
        this.Va = -1;
      }
      ;
      function La() {
        this.Va = -1;
        this.Va = 64;
        this.N = [];
        this.me = [];
        this.Wf = [];
        this.Ld = [];
        this.Ld[0] = 128;
        for (var a = 1; a < this.Va; ++a)
          this.Ld[a] = 0;
        this.de = this.ac = 0;
        this.reset();
      }
      ma(La, Ka);
      La.prototype.reset = function() {
        this.N[0] = 1732584193;
        this.N[1] = 4023233417;
        this.N[2] = 2562383102;
        this.N[3] = 271733878;
        this.N[4] = 3285377520;
        this.de = this.ac = 0;
      };
      function Ma(a, b, c) {
        c || (c = 0);
        var d = a.Wf;
        if (p(b))
          for (var e = 0; 16 > e; e++)
            d[e] = b.charCodeAt(c) << 24 | b.charCodeAt(c + 1) << 16 | b.charCodeAt(c + 2) << 8 | b.charCodeAt(c + 3), c += 4;
        else
          for (e = 0; 16 > e; e++)
            d[e] = b[c] << 24 | b[c + 1] << 16 | b[c + 2] << 8 | b[c + 3], c += 4;
        for (e = 16; 80 > e; e++) {
          var f = d[e - 3] ^ d[e - 8] ^ d[e - 14] ^ d[e - 16];
          d[e] = (f << 1 | f >>> 31) & 4294967295;
        }
        b = a.N[0];
        c = a.N[1];
        for (var h = a.N[2],
            k = a.N[3],
            l = a.N[4],
            m,
            e = 0; 80 > e; e++)
          40 > e ? 20 > e ? (f = k ^ c & (h ^ k), m = 1518500249) : (f = c ^ h ^ k, m = 1859775393) : 60 > e ? (f = c & h | k & (c | h), m = 2400959708) : (f = c ^ h ^ k, m = 3395469782), f = (b << 5 | b >>> 27) + f + l + m + d[e] & 4294967295, l = k, k = h, h = (c << 30 | c >>> 2) & 4294967295, c = b, b = f;
        a.N[0] = a.N[0] + b & 4294967295;
        a.N[1] = a.N[1] + c & 4294967295;
        a.N[2] = a.N[2] + h & 4294967295;
        a.N[3] = a.N[3] + k & 4294967295;
        a.N[4] = a.N[4] + l & 4294967295;
      }
      La.prototype.update = function(a, b) {
        if (null != a) {
          n(b) || (b = a.length);
          for (var c = b - this.Va,
              d = 0,
              e = this.me,
              f = this.ac; d < b; ) {
            if (0 == f)
              for (; d <= c; )
                Ma(this, a, d), d += this.Va;
            if (p(a))
              for (; d < b; ) {
                if (e[f] = a.charCodeAt(d), ++f, ++d, f == this.Va) {
                  Ma(this, e);
                  f = 0;
                  break;
                }
              }
            else
              for (; d < b; )
                if (e[f] = a[d], ++f, ++d, f == this.Va) {
                  Ma(this, e);
                  f = 0;
                  break;
                }
          }
          this.ac = f;
          this.de += b;
        }
      };
      var u = Array.prototype,
          Na = u.indexOf ? function(a, b, c) {
            return u.indexOf.call(a, b, c);
          } : function(a, b, c) {
            c = null == c ? 0 : 0 > c ? Math.max(0, a.length + c) : c;
            if (p(a))
              return p(b) && 1 == b.length ? a.indexOf(b, c) : -1;
            for (; c < a.length; c++)
              if (c in a && a[c] === b)
                return c;
            return -1;
          },
          Oa = u.forEach ? function(a, b, c) {
            u.forEach.call(a, b, c);
          } : function(a, b, c) {
            for (var d = a.length,
                e = p(a) ? a.split("") : a,
                f = 0; f < d; f++)
              f in e && b.call(c, e[f], f, a);
          },
          Pa = u.filter ? function(a, b, c) {
            return u.filter.call(a, b, c);
          } : function(a, b, c) {
            for (var d = a.length,
                e = [],
                f = 0,
                h = p(a) ? a.split("") : a,
                k = 0; k < d; k++)
              if (k in h) {
                var l = h[k];
                b.call(c, l, k, a) && (e[f++] = l);
              }
            return e;
          },
          Qa = u.map ? function(a, b, c) {
            return u.map.call(a, b, c);
          } : function(a, b, c) {
            for (var d = a.length,
                e = Array(d),
                f = p(a) ? a.split("") : a,
                h = 0; h < d; h++)
              h in f && (e[h] = b.call(c, f[h], h, a));
            return e;
          },
          Ra = u.reduce ? function(a, b, c, d) {
            for (var e = [],
                f = 1,
                h = arguments.length; f < h; f++)
              e.push(arguments[f]);
            d && (e[0] = q(b, d));
            return u.reduce.apply(a, e);
          } : function(a, b, c, d) {
            var e = c;
            Oa(a, function(c, h) {
              e = b.call(d, e, c, h, a);
            });
            return e;
          },
          Sa = u.every ? function(a, b, c) {
            return u.every.call(a, b, c);
          } : function(a, b, c) {
            for (var d = a.length,
                e = p(a) ? a.split("") : a,
                f = 0; f < d; f++)
              if (f in e && !b.call(c, e[f], f, a))
                return !1;
            return !0;
          };
      function Ta(a, b) {
        var c = Ua(a, b, void 0);
        return 0 > c ? null : p(a) ? a.charAt(c) : a[c];
      }
      function Ua(a, b, c) {
        for (var d = a.length,
            e = p(a) ? a.split("") : a,
            f = 0; f < d; f++)
          if (f in e && b.call(c, e[f], f, a))
            return f;
        return -1;
      }
      function Va(a, b) {
        var c = Na(a, b);
        0 <= c && u.splice.call(a, c, 1);
      }
      function Wa(a, b, c) {
        return 2 >= arguments.length ? u.slice.call(a, b) : u.slice.call(a, b, c);
      }
      function Xa(a, b) {
        a.sort(b || Ya);
      }
      function Ya(a, b) {
        return a > b ? 1 : a < b ? -1 : 0;
      }
      ;
      var Za = -1 != Ha.indexOf("Opera") || -1 != Ha.indexOf("OPR"),
          $a = -1 != Ha.indexOf("Trident") || -1 != Ha.indexOf("MSIE"),
          ab = -1 != Ha.indexOf("Gecko") && -1 == Ha.toLowerCase().indexOf("webkit") && !(-1 != Ha.indexOf("Trident") || -1 != Ha.indexOf("MSIE")),
          bb = -1 != Ha.toLowerCase().indexOf("webkit");
      (function() {
        var a = "",
            b;
        if (Za && aa.opera)
          return a = aa.opera.version, ha(a) ? a() : a;
        ab ? b = /rv\:([^\);]+)(\)|;)/ : $a ? b = /\b(?:MSIE|rv)[: ]([^\);]+)(\)|;)/ : bb && (b = /WebKit\/(\S+)/);
        b && (a = (a = b.exec(Ha)) ? a[1] : "");
        return $a && (b = (b = aa.document) ? b.documentMode : void 0, b > parseFloat(a)) ? String(b) : a;
      })();
      var cb = null,
          db = null,
          eb = null;
      function fb(a, b) {
        if (!fa(a))
          throw Error("encodeByteArray takes an array as a parameter");
        gb();
        for (var c = b ? db : cb,
            d = [],
            e = 0; e < a.length; e += 3) {
          var f = a[e],
              h = e + 1 < a.length,
              k = h ? a[e + 1] : 0,
              l = e + 2 < a.length,
              m = l ? a[e + 2] : 0,
              t = f >> 2,
              f = (f & 3) << 4 | k >> 4,
              k = (k & 15) << 2 | m >> 6,
              m = m & 63;
          l || (m = 64, h || (k = 64));
          d.push(c[t], c[f], c[k], c[m]);
        }
        return d.join("");
      }
      function gb() {
        if (!cb) {
          cb = {};
          db = {};
          eb = {};
          for (var a = 0; 65 > a; a++)
            cb[a] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=".charAt(a), db[a] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.".charAt(a), eb[db[a]] = a, 62 <= a && (eb["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=".charAt(a)] = a);
        }
      }
      ;
      var hb = hb || "2.3.1";
      function v(a, b) {
        return Object.prototype.hasOwnProperty.call(a, b);
      }
      function w(a, b) {
        if (Object.prototype.hasOwnProperty.call(a, b))
          return a[b];
      }
      function ib(a, b) {
        for (var c in a)
          Object.prototype.hasOwnProperty.call(a, c) && b(c, a[c]);
      }
      function jb(a) {
        var b = {};
        ib(a, function(a, d) {
          b[a] = d;
        });
        return b;
      }
      ;
      function kb(a) {
        var b = [];
        ib(a, function(a, d) {
          ea(d) ? Oa(d, function(d) {
            b.push(encodeURIComponent(a) + "=" + encodeURIComponent(d));
          }) : b.push(encodeURIComponent(a) + "=" + encodeURIComponent(d));
        });
        return b.length ? "&" + b.join("&") : "";
      }
      function lb(a) {
        var b = {};
        a = a.replace(/^\?/, "").split("&");
        Oa(a, function(a) {
          a && (a = a.split("="), b[a[0]] = a[1]);
        });
        return b;
      }
      ;
      function x(a, b, c, d) {
        var e;
        d < b ? e = "at least " + b : d > c && (e = 0 === c ? "none" : "no more than " + c);
        if (e)
          throw Error(a + " failed: Was called with " + d + (1 === d ? " argument." : " arguments.") + " Expects " + e + ".");
      }
      function y(a, b, c) {
        var d = "";
        switch (b) {
          case 1:
            d = c ? "first" : "First";
            break;
          case 2:
            d = c ? "second" : "Second";
            break;
          case 3:
            d = c ? "third" : "Third";
            break;
          case 4:
            d = c ? "fourth" : "Fourth";
            break;
          default:
            throw Error("errorPrefix called with argumentNumber > 4.  Need to update it?");
        }
        return a = a + " failed: " + (d + " argument ");
      }
      function A(a, b, c, d) {
        if ((!d || n(c)) && !ha(c))
          throw Error(y(a, b, d) + "must be a valid function.");
      }
      function mb(a, b, c) {
        if (n(c) && (!ia(c) || null === c))
          throw Error(y(a, b, !0) + "must be a valid context object.");
      }
      ;
      function nb(a) {
        return "undefined" !== typeof JSON && n(JSON.parse) ? JSON.parse(a) : Aa(a);
      }
      function B(a) {
        if ("undefined" !== typeof JSON && n(JSON.stringify))
          a = JSON.stringify(a);
        else {
          var b = [];
          Ca(new Ba, a, b);
          a = b.join("");
        }
        return a;
      }
      ;
      function ob() {
        this.Wd = C;
      }
      ob.prototype.j = function(a) {
        return this.Wd.Q(a);
      };
      ob.prototype.toString = function() {
        return this.Wd.toString();
      };
      function pb() {}
      pb.prototype.qf = function() {
        return null;
      };
      pb.prototype.ye = function() {
        return null;
      };
      var qb = new pb;
      function rb(a, b, c) {
        this.Tf = a;
        this.Ka = b;
        this.Kd = c;
      }
      rb.prototype.qf = function(a) {
        var b = this.Ka.O;
        if (sb(b, a))
          return b.j().R(a);
        b = null != this.Kd ? new tb(this.Kd, !0, !1) : this.Ka.w();
        return this.Tf.xc(a, b);
      };
      rb.prototype.ye = function(a, b, c) {
        var d = null != this.Kd ? this.Kd : ub(this.Ka);
        a = this.Tf.ne(d, b, 1, c, a);
        return 0 === a.length ? null : a[0];
      };
      function vb() {
        this.tb = [];
      }
      function wb(a, b) {
        for (var c = null,
            d = 0; d < b.length; d++) {
          var e = b[d],
              f = e.Zb();
          null === c || f.ca(c.Zb()) || (a.tb.push(c), c = null);
          null === c && (c = new xb(f));
          c.add(e);
        }
        c && a.tb.push(c);
      }
      function yb(a, b, c) {
        wb(a, c);
        zb(a, function(a) {
          return a.ca(b);
        });
      }
      function Ab(a, b, c) {
        wb(a, c);
        zb(a, function(a) {
          return a.contains(b) || b.contains(a);
        });
      }
      function zb(a, b) {
        for (var c = !0,
            d = 0; d < a.tb.length; d++) {
          var e = a.tb[d];
          if (e)
            if (e = e.Zb(), b(e)) {
              for (var e = a.tb[d],
                  f = 0; f < e.vd.length; f++) {
                var h = e.vd[f];
                if (null !== h) {
                  e.vd[f] = null;
                  var k = h.Vb();
                  Bb && Cb("event: " + h.toString());
                  Db(k);
                }
              }
              a.tb[d] = null;
            } else
              c = !1;
        }
        c && (a.tb = []);
      }
      function xb(a) {
        this.ra = a;
        this.vd = [];
      }
      xb.prototype.add = function(a) {
        this.vd.push(a);
      };
      xb.prototype.Zb = function() {
        return this.ra;
      };
      function D(a, b, c, d) {
        this.type = a;
        this.Ja = b;
        this.Wa = c;
        this.Ke = d;
        this.Qd = void 0;
      }
      function Eb(a) {
        return new D(Fb, a);
      }
      var Fb = "value";
      function Gb(a, b, c, d) {
        this.ue = b;
        this.Zd = c;
        this.Qd = d;
        this.ud = a;
      }
      Gb.prototype.Zb = function() {
        var a = this.Zd.Ib();
        return "value" === this.ud ? a.path : a.parent().path;
      };
      Gb.prototype.ze = function() {
        return this.ud;
      };
      Gb.prototype.Vb = function() {
        return this.ue.Vb(this);
      };
      Gb.prototype.toString = function() {
        return this.Zb().toString() + ":" + this.ud + ":" + B(this.Zd.mf());
      };
      function Hb(a, b, c) {
        this.ue = a;
        this.error = b;
        this.path = c;
      }
      Hb.prototype.Zb = function() {
        return this.path;
      };
      Hb.prototype.ze = function() {
        return "cancel";
      };
      Hb.prototype.Vb = function() {
        return this.ue.Vb(this);
      };
      Hb.prototype.toString = function() {
        return this.path.toString() + ":cancel";
      };
      function tb(a, b, c) {
        this.A = a;
        this.ea = b;
        this.Ub = c;
      }
      function Ib(a) {
        return a.ea;
      }
      function Jb(a) {
        return a.Ub;
      }
      function Kb(a, b) {
        return b.e() ? a.ea && !a.Ub : sb(a, E(b));
      }
      function sb(a, b) {
        return a.ea && !a.Ub || a.A.Da(b);
      }
      tb.prototype.j = function() {
        return this.A;
      };
      function Lb(a) {
        this.gg = a;
        this.Dd = null;
      }
      Lb.prototype.get = function() {
        var a = this.gg.get(),
            b = xa(a);
        if (this.Dd)
          for (var c in this.Dd)
            b[c] -= this.Dd[c];
        this.Dd = a;
        return b;
      };
      function Mb(a, b) {
        this.Of = {};
        this.fd = new Lb(a);
        this.ba = b;
        var c = 1E4 + 2E4 * Math.random();
        setTimeout(q(this.If, this), Math.floor(c));
      }
      Mb.prototype.If = function() {
        var a = this.fd.get(),
            b = {},
            c = !1,
            d;
        for (d in a)
          0 < a[d] && v(this.Of, d) && (b[d] = a[d], c = !0);
        c && this.ba.Ue(b);
        setTimeout(q(this.If, this), Math.floor(6E5 * Math.random()));
      };
      function Nb() {
        this.Ec = {};
      }
      function Ob(a, b, c) {
        n(c) || (c = 1);
        v(a.Ec, b) || (a.Ec[b] = 0);
        a.Ec[b] += c;
      }
      Nb.prototype.get = function() {
        return xa(this.Ec);
      };
      var Pb = {},
          Qb = {};
      function Rb(a) {
        a = a.toString();
        Pb[a] || (Pb[a] = new Nb);
        return Pb[a];
      }
      function Sb(a, b) {
        var c = a.toString();
        Qb[c] || (Qb[c] = b());
        return Qb[c];
      }
      ;
      function F(a, b) {
        this.name = a;
        this.S = b;
      }
      function Tb(a, b) {
        return new F(a, b);
      }
      ;
      function Ub(a, b) {
        return Vb(a.name, b.name);
      }
      function Wb(a, b) {
        return Vb(a, b);
      }
      ;
      function Xb(a, b, c) {
        this.type = Yb;
        this.source = a;
        this.path = b;
        this.Ga = c;
      }
      Xb.prototype.Xc = function(a) {
        return this.path.e() ? new Xb(this.source, G, this.Ga.R(a)) : new Xb(this.source, H(this.path), this.Ga);
      };
      Xb.prototype.toString = function() {
        return "Operation(" + this.path + ": " + this.source.toString() + " overwrite: " + this.Ga.toString() + ")";
      };
      function Zb(a, b) {
        this.type = $b;
        this.source = a;
        this.path = b;
      }
      Zb.prototype.Xc = function() {
        return this.path.e() ? new Zb(this.source, G) : new Zb(this.source, H(this.path));
      };
      Zb.prototype.toString = function() {
        return "Operation(" + this.path + ": " + this.source.toString() + " listen_complete)";
      };
      function ac(a, b) {
        this.La = a;
        this.wa = b ? b : bc;
      }
      g = ac.prototype;
      g.Oa = function(a, b) {
        return new ac(this.La, this.wa.Oa(a, b, this.La).Y(null, null, !1, null, null));
      };
      g.remove = function(a) {
        return new ac(this.La, this.wa.remove(a, this.La).Y(null, null, !1, null, null));
      };
      g.get = function(a) {
        for (var b,
            c = this.wa; !c.e(); ) {
          b = this.La(a, c.key);
          if (0 === b)
            return c.value;
          0 > b ? c = c.left : 0 < b && (c = c.right);
        }
        return null;
      };
      function cc(a, b) {
        for (var c,
            d = a.wa,
            e = null; !d.e(); ) {
          c = a.La(b, d.key);
          if (0 === c) {
            if (d.left.e())
              return e ? e.key : null;
            for (d = d.left; !d.right.e(); )
              d = d.right;
            return d.key;
          }
          0 > c ? d = d.left : 0 < c && (e = d, d = d.right);
        }
        throw Error("Attempted to find predecessor key for a nonexistent key.  What gives?");
      }
      g.e = function() {
        return this.wa.e();
      };
      g.count = function() {
        return this.wa.count();
      };
      g.Sc = function() {
        return this.wa.Sc();
      };
      g.fc = function() {
        return this.wa.fc();
      };
      g.ia = function(a) {
        return this.wa.ia(a);
      };
      g.Xb = function(a) {
        return new dc(this.wa, null, this.La, !1, a);
      };
      g.Yb = function(a, b) {
        return new dc(this.wa, a, this.La, !1, b);
      };
      g.$b = function(a, b) {
        return new dc(this.wa, a, this.La, !0, b);
      };
      g.sf = function(a) {
        return new dc(this.wa, null, this.La, !0, a);
      };
      function dc(a, b, c, d, e) {
        this.Ud = e || null;
        this.Fe = d;
        this.Pa = [];
        for (e = 1; !a.e(); )
          if (e = b ? c(a.key, b) : 1, d && (e *= -1), 0 > e)
            a = this.Fe ? a.left : a.right;
          else if (0 === e) {
            this.Pa.push(a);
            break;
          } else
            this.Pa.push(a), a = this.Fe ? a.right : a.left;
      }
      function J(a) {
        if (0 === a.Pa.length)
          return null;
        var b = a.Pa.pop(),
            c;
        c = a.Ud ? a.Ud(b.key, b.value) : {
          key: b.key,
          value: b.value
        };
        if (a.Fe)
          for (b = b.left; !b.e(); )
            a.Pa.push(b), b = b.right;
        else
          for (b = b.right; !b.e(); )
            a.Pa.push(b), b = b.left;
        return c;
      }
      function ec(a) {
        if (0 === a.Pa.length)
          return null;
        var b;
        b = a.Pa;
        b = b[b.length - 1];
        return a.Ud ? a.Ud(b.key, b.value) : {
          key: b.key,
          value: b.value
        };
      }
      function fc(a, b, c, d, e) {
        this.key = a;
        this.value = b;
        this.color = null != c ? c : !0;
        this.left = null != d ? d : bc;
        this.right = null != e ? e : bc;
      }
      g = fc.prototype;
      g.Y = function(a, b, c, d, e) {
        return new fc(null != a ? a : this.key, null != b ? b : this.value, null != c ? c : this.color, null != d ? d : this.left, null != e ? e : this.right);
      };
      g.count = function() {
        return this.left.count() + 1 + this.right.count();
      };
      g.e = function() {
        return !1;
      };
      g.ia = function(a) {
        return this.left.ia(a) || a(this.key, this.value) || this.right.ia(a);
      };
      function gc(a) {
        return a.left.e() ? a : gc(a.left);
      }
      g.Sc = function() {
        return gc(this).key;
      };
      g.fc = function() {
        return this.right.e() ? this.key : this.right.fc();
      };
      g.Oa = function(a, b, c) {
        var d,
            e;
        e = this;
        d = c(a, e.key);
        e = 0 > d ? e.Y(null, null, null, e.left.Oa(a, b, c), null) : 0 === d ? e.Y(null, b, null, null, null) : e.Y(null, null, null, null, e.right.Oa(a, b, c));
        return hc(e);
      };
      function ic(a) {
        if (a.left.e())
          return bc;
        a.left.fa() || a.left.left.fa() || (a = jc(a));
        a = a.Y(null, null, null, ic(a.left), null);
        return hc(a);
      }
      g.remove = function(a, b) {
        var c,
            d;
        c = this;
        if (0 > b(a, c.key))
          c.left.e() || c.left.fa() || c.left.left.fa() || (c = jc(c)), c = c.Y(null, null, null, c.left.remove(a, b), null);
        else {
          c.left.fa() && (c = kc(c));
          c.right.e() || c.right.fa() || c.right.left.fa() || (c = lc(c), c.left.left.fa() && (c = kc(c), c = lc(c)));
          if (0 === b(a, c.key)) {
            if (c.right.e())
              return bc;
            d = gc(c.right);
            c = c.Y(d.key, d.value, null, null, ic(c.right));
          }
          c = c.Y(null, null, null, null, c.right.remove(a, b));
        }
        return hc(c);
      };
      g.fa = function() {
        return this.color;
      };
      function hc(a) {
        a.right.fa() && !a.left.fa() && (a = mc(a));
        a.left.fa() && a.left.left.fa() && (a = kc(a));
        a.left.fa() && a.right.fa() && (a = lc(a));
        return a;
      }
      function jc(a) {
        a = lc(a);
        a.right.left.fa() && (a = a.Y(null, null, null, null, kc(a.right)), a = mc(a), a = lc(a));
        return a;
      }
      function mc(a) {
        return a.right.Y(null, null, a.color, a.Y(null, null, !0, null, a.right.left), null);
      }
      function kc(a) {
        return a.left.Y(null, null, a.color, null, a.Y(null, null, !0, a.left.right, null));
      }
      function lc(a) {
        return a.Y(null, null, !a.color, a.left.Y(null, null, !a.left.color, null, null), a.right.Y(null, null, !a.right.color, null, null));
      }
      function nc() {}
      g = nc.prototype;
      g.Y = function() {
        return this;
      };
      g.Oa = function(a, b) {
        return new fc(a, b, null);
      };
      g.remove = function() {
        return this;
      };
      g.count = function() {
        return 0;
      };
      g.e = function() {
        return !0;
      };
      g.ia = function() {
        return !1;
      };
      g.Sc = function() {
        return null;
      };
      g.fc = function() {
        return null;
      };
      g.fa = function() {
        return !1;
      };
      var bc = new nc;
      function oc(a, b) {
        return a && "object" === typeof a ? (K(".sv" in a, "Unexpected leaf node or priority contents"), b[a[".sv"]]) : a;
      }
      function pc(a, b) {
        var c = new qc;
        rc(a, new L(""), function(a, e) {
          c.nc(a, sc(e, b));
        });
        return c;
      }
      function sc(a, b) {
        var c = a.C().I(),
            c = oc(c, b),
            d;
        if (a.K()) {
          var e = oc(a.Ca(), b);
          return e !== a.Ca() || c !== a.C().I() ? new tc(e, M(c)) : a;
        }
        d = a;
        c !== a.C().I() && (d = d.ga(new tc(c)));
        a.P(N, function(a, c) {
          var e = sc(c, b);
          e !== c && (d = d.U(a, e));
        });
        return d;
      }
      ;
      function uc() {
        this.wc = {};
      }
      uc.prototype.set = function(a, b) {
        null == b ? delete this.wc[a] : this.wc[a] = b;
      };
      uc.prototype.get = function(a) {
        return v(this.wc, a) ? this.wc[a] : null;
      };
      uc.prototype.remove = function(a) {
        delete this.wc[a];
      };
      uc.prototype.wf = !0;
      function vc(a) {
        this.Fc = a;
        this.Pd = "firebase:";
      }
      g = vc.prototype;
      g.set = function(a, b) {
        null == b ? this.Fc.removeItem(this.Pd + a) : this.Fc.setItem(this.Pd + a, B(b));
      };
      g.get = function(a) {
        a = this.Fc.getItem(this.Pd + a);
        return null == a ? null : nb(a);
      };
      g.remove = function(a) {
        this.Fc.removeItem(this.Pd + a);
      };
      g.wf = !1;
      g.toString = function() {
        return this.Fc.toString();
      };
      function wc(a) {
        try {
          if ("undefined" !== typeof window && "undefined" !== typeof window[a]) {
            var b = window[a];
            b.setItem("firebase:sentinel", "cache");
            b.removeItem("firebase:sentinel");
            return new vc(b);
          }
        } catch (c) {}
        return new uc;
      }
      var xc = wc("localStorage"),
          yc = wc("sessionStorage");
      function zc(a, b, c, d, e) {
        this.host = a.toLowerCase();
        this.domain = this.host.substr(this.host.indexOf(".") + 1);
        this.kb = b;
        this.hc = c;
        this.Wg = d;
        this.Od = e || "";
        this.Ya = xc.get("host:" + a) || this.host;
      }
      function Ac(a, b) {
        b !== a.Ya && (a.Ya = b, "s-" === a.Ya.substr(0, 2) && xc.set("host:" + a.host, a.Ya));
      }
      function Bc(a, b, c) {
        K("string" === typeof b, "typeof type must == string");
        K("object" === typeof c, "typeof params must == object");
        if (b === Cc)
          b = (a.kb ? "wss://" : "ws://") + a.Ya + "/.ws?";
        else if (b === Dc)
          b = (a.kb ? "https://" : "http://") + a.Ya + "/.lp?";
        else
          throw Error("Unknown connection type: " + b);
        a.host !== a.Ya && (c.ns = a.hc);
        var d = [];
        r(c, function(a, b) {
          d.push(b + "=" + a);
        });
        return b + d.join("&");
      }
      zc.prototype.toString = function() {
        var a = (this.kb ? "https://" : "http://") + this.host;
        this.Od && (a += "<" + this.Od + ">");
        return a;
      };
      var Ec = function() {
        var a = 1;
        return function() {
          return a++;
        };
      }();
      function K(a, b) {
        if (!a)
          throw Fc(b);
      }
      function Fc(a) {
        return Error("Firebase (" + hb + ") INTERNAL ASSERT FAILED: " + a);
      }
      function Gc(a) {
        try {
          var b;
          if ("undefined" !== typeof atob)
            b = atob(a);
          else {
            gb();
            for (var c = eb,
                d = [],
                e = 0; e < a.length; ) {
              var f = c[a.charAt(e++)],
                  h = e < a.length ? c[a.charAt(e)] : 0;
              ++e;
              var k = e < a.length ? c[a.charAt(e)] : 64;
              ++e;
              var l = e < a.length ? c[a.charAt(e)] : 64;
              ++e;
              if (null == f || null == h || null == k || null == l)
                throw Error();
              d.push(f << 2 | h >> 4);
              64 != k && (d.push(h << 4 & 240 | k >> 2), 64 != l && d.push(k << 6 & 192 | l));
            }
            if (8192 > d.length)
              b = String.fromCharCode.apply(null, d);
            else {
              a = "";
              for (c = 0; c < d.length; c += 8192)
                a += String.fromCharCode.apply(null, Wa(d, c, c + 8192));
              b = a;
            }
          }
          return b;
        } catch (m) {
          Cb("base64Decode failed: ", m);
        }
        return null;
      }
      function Hc(a) {
        var b = Ic(a);
        a = new La;
        a.update(b);
        var b = [],
            c = 8 * a.de;
        56 > a.ac ? a.update(a.Ld, 56 - a.ac) : a.update(a.Ld, a.Va - (a.ac - 56));
        for (var d = a.Va - 1; 56 <= d; d--)
          a.me[d] = c & 255, c /= 256;
        Ma(a, a.me);
        for (d = c = 0; 5 > d; d++)
          for (var e = 24; 0 <= e; e -= 8)
            b[c] = a.N[d] >> e & 255, ++c;
        return fb(b);
      }
      function Jc(a) {
        for (var b = "",
            c = 0; c < arguments.length; c++)
          b = fa(arguments[c]) ? b + Jc.apply(null, arguments[c]) : "object" === typeof arguments[c] ? b + B(arguments[c]) : b + arguments[c], b += " ";
        return b;
      }
      var Bb = null,
          Kc = !0;
      function Cb(a) {
        !0 === Kc && (Kc = !1, null === Bb && !0 === yc.get("logging_enabled") && Lc(!0));
        if (Bb) {
          var b = Jc.apply(null, arguments);
          Bb(b);
        }
      }
      function Mc(a) {
        return function() {
          Cb(a, arguments);
        };
      }
      function Nc(a) {
        if ("undefined" !== typeof console) {
          var b = "FIREBASE INTERNAL ERROR: " + Jc.apply(null, arguments);
          "undefined" !== typeof console.error ? console.error(b) : console.log(b);
        }
      }
      function Oc(a) {
        var b = Jc.apply(null, arguments);
        throw Error("FIREBASE FATAL ERROR: " + b);
      }
      function O(a) {
        if ("undefined" !== typeof console) {
          var b = "FIREBASE WARNING: " + Jc.apply(null, arguments);
          "undefined" !== typeof console.warn ? console.warn(b) : console.log(b);
        }
      }
      function Pc(a) {
        var b = "",
            c = "",
            d = "",
            e = "",
            f = !0,
            h = "https",
            k = 443;
        if (p(a)) {
          var l = a.indexOf("//");
          0 <= l && (h = a.substring(0, l - 1), a = a.substring(l + 2));
          l = a.indexOf("/");
          -1 === l && (l = a.length);
          b = a.substring(0, l);
          e = "";
          a = a.substring(l).split("/");
          for (l = 0; l < a.length; l++)
            if (0 < a[l].length) {
              var m = a[l];
              try {
                m = decodeURIComponent(m.replace(/\+/g, " "));
              } catch (t) {}
              e += "/" + m;
            }
          a = b.split(".");
          3 === a.length ? (c = a[1], d = a[0].toLowerCase()) : 2 === a.length && (c = a[0]);
          l = b.indexOf(":");
          0 <= l && (f = "https" === h || "wss" === h, k = b.substring(l + 1), isFinite(k) && (k = String(k)), k = p(k) ? /^\s*-?0x/i.test(k) ? parseInt(k, 16) : parseInt(k, 10) : NaN);
        }
        return {
          host: b,
          port: k,
          domain: c,
          Tg: d,
          kb: f,
          scheme: h,
          $c: e
        };
      }
      function Qc(a) {
        return ga(a) && (a != a || a == Number.POSITIVE_INFINITY || a == Number.NEGATIVE_INFINITY);
      }
      function Rc(a) {
        if ("complete" === document.readyState)
          a();
        else {
          var b = !1,
              c = function() {
                document.body ? b || (b = !0, a()) : setTimeout(c, Math.floor(10));
              };
          document.addEventListener ? (document.addEventListener("DOMContentLoaded", c, !1), window.addEventListener("load", c, !1)) : document.attachEvent && (document.attachEvent("onreadystatechange", function() {
            "complete" === document.readyState && c();
          }), window.attachEvent("onload", c));
        }
      }
      function Vb(a, b) {
        if (a === b)
          return 0;
        if ("[MIN_NAME]" === a || "[MAX_NAME]" === b)
          return -1;
        if ("[MIN_NAME]" === b || "[MAX_NAME]" === a)
          return 1;
        var c = Sc(a),
            d = Sc(b);
        return null !== c ? null !== d ? 0 == c - d ? a.length - b.length : c - d : -1 : null !== d ? 1 : a < b ? -1 : 1;
      }
      function Tc(a, b) {
        if (b && a in b)
          return b[a];
        throw Error("Missing required key (" + a + ") in object: " + B(b));
      }
      function Uc(a) {
        if ("object" !== typeof a || null === a)
          return B(a);
        var b = [],
            c;
        for (c in a)
          b.push(c);
        b.sort();
        c = "{";
        for (var d = 0; d < b.length; d++)
          0 !== d && (c += ","), c += B(b[d]), c += ":", c += Uc(a[b[d]]);
        return c + "}";
      }
      function Vc(a, b) {
        if (a.length <= b)
          return [a];
        for (var c = [],
            d = 0; d < a.length; d += b)
          d + b > a ? c.push(a.substring(d, a.length)) : c.push(a.substring(d, d + b));
        return c;
      }
      function Wc(a, b) {
        if (ea(a))
          for (var c = 0; c < a.length; ++c)
            b(c, a[c]);
        else
          r(a, b);
      }
      function Xc(a) {
        K(!Qc(a), "Invalid JSON number");
        var b,
            c,
            d,
            e;
        0 === a ? (d = c = 0, b = -Infinity === 1 / a ? 1 : 0) : (b = 0 > a, a = Math.abs(a), a >= Math.pow(2, -1022) ? (d = Math.min(Math.floor(Math.log(a) / Math.LN2), 1023), c = d + 1023, d = Math.round(a * Math.pow(2, 52 - d) - Math.pow(2, 52))) : (c = 0, d = Math.round(a / Math.pow(2, -1074))));
        e = [];
        for (a = 52; a; --a)
          e.push(d % 2 ? 1 : 0), d = Math.floor(d / 2);
        for (a = 11; a; --a)
          e.push(c % 2 ? 1 : 0), c = Math.floor(c / 2);
        e.push(b ? 1 : 0);
        e.reverse();
        b = e.join("");
        c = "";
        for (a = 0; 64 > a; a += 8)
          d = parseInt(b.substr(a, 8), 2).toString(16), 1 === d.length && (d = "0" + d), c += d;
        return c.toLowerCase();
      }
      var Yc = /^-?\d{1,10}$/;
      function Sc(a) {
        return Yc.test(a) && (a = Number(a), -2147483648 <= a && 2147483647 >= a) ? a : null;
      }
      function Db(a) {
        try {
          a();
        } catch (b) {
          setTimeout(function() {
            O("Exception was thrown by user callback.", b.stack || "");
            throw b;
          }, Math.floor(0));
        }
      }
      function P(a, b) {
        if (ha(a)) {
          var c = Array.prototype.slice.call(arguments, 1).slice();
          Db(function() {
            a.apply(null, c);
          });
        }
      }
      ;
      function Ic(a) {
        for (var b = [],
            c = 0,
            d = 0; d < a.length; d++) {
          var e = a.charCodeAt(d);
          55296 <= e && 56319 >= e && (e -= 55296, d++, K(d < a.length, "Surrogate pair missing trail surrogate."), e = 65536 + (e << 10) + (a.charCodeAt(d) - 56320));
          128 > e ? b[c++] = e : (2048 > e ? b[c++] = e >> 6 | 192 : (65536 > e ? b[c++] = e >> 12 | 224 : (b[c++] = e >> 18 | 240, b[c++] = e >> 12 & 63 | 128), b[c++] = e >> 6 & 63 | 128), b[c++] = e & 63 | 128);
        }
        return b;
      }
      function Zc(a) {
        for (var b = 0,
            c = 0; c < a.length; c++) {
          var d = a.charCodeAt(c);
          128 > d ? b++ : 2048 > d ? b += 2 : 55296 <= d && 56319 >= d ? (b += 4, c++) : b += 3;
        }
        return b;
      }
      ;
      function $c(a) {
        var b = {},
            c = {},
            d = {},
            e = "";
        try {
          var f = a.split("."),
              b = nb(Gc(f[0]) || ""),
              c = nb(Gc(f[1]) || ""),
              e = f[2],
              d = c.d || {};
          delete c.d;
        } catch (h) {}
        return {
          Zg: b,
          Bc: c,
          data: d,
          Qg: e
        };
      }
      function ad(a) {
        a = $c(a).Bc;
        return "object" === typeof a && a.hasOwnProperty("iat") ? w(a, "iat") : null;
      }
      function bd(a) {
        a = $c(a);
        var b = a.Bc;
        return !!a.Qg && !!b && "object" === typeof b && b.hasOwnProperty("iat");
      }
      ;
      function cd(a) {
        this.W = a;
        this.g = a.n.g;
      }
      function dd(a, b, c, d) {
        var e = [],
            f = [];
        Oa(b, function(b) {
          "child_changed" === b.type && a.g.Ad(b.Ke, b.Ja) && f.push(new D("child_moved", b.Ja, b.Wa));
        });
        ed(a, e, "child_removed", b, d, c);
        ed(a, e, "child_added", b, d, c);
        ed(a, e, "child_moved", f, d, c);
        ed(a, e, "child_changed", b, d, c);
        ed(a, e, Fb, b, d, c);
        return e;
      }
      function ed(a, b, c, d, e, f) {
        d = Pa(d, function(a) {
          return a.type === c;
        });
        Xa(d, q(a.hg, a));
        Oa(d, function(c) {
          var d = fd(a, c, f);
          Oa(e, function(e) {
            e.Kf(c.type) && b.push(e.createEvent(d, a.W));
          });
        });
      }
      function fd(a, b, c) {
        "value" !== b.type && "child_removed" !== b.type && (b.Qd = c.rf(b.Wa, b.Ja, a.g));
        return b;
      }
      cd.prototype.hg = function(a, b) {
        if (null == a.Wa || null == b.Wa)
          throw Fc("Should only compare child_ events.");
        return this.g.compare(new F(a.Wa, a.Ja), new F(b.Wa, b.Ja));
      };
      function gd() {
        this.bb = {};
      }
      function hd(a, b) {
        var c = b.type,
            d = b.Wa;
        K("child_added" == c || "child_changed" == c || "child_removed" == c, "Only child changes supported for tracking");
        K(".priority" !== d, "Only non-priority child changes can be tracked.");
        var e = w(a.bb, d);
        if (e) {
          var f = e.type;
          if ("child_added" == c && "child_removed" == f)
            a.bb[d] = new D("child_changed", b.Ja, d, e.Ja);
          else if ("child_removed" == c && "child_added" == f)
            delete a.bb[d];
          else if ("child_removed" == c && "child_changed" == f)
            a.bb[d] = new D("child_removed", e.Ke, d);
          else if ("child_changed" == c && "child_added" == f)
            a.bb[d] = new D("child_added", b.Ja, d);
          else if ("child_changed" == c && "child_changed" == f)
            a.bb[d] = new D("child_changed", b.Ja, d, e.Ke);
          else
            throw Fc("Illegal combination of changes: " + b + " occurred after " + e);
        } else
          a.bb[d] = b;
      }
      ;
      function id(a, b, c) {
        this.Rb = a;
        this.pb = b;
        this.rb = c || null;
      }
      g = id.prototype;
      g.Kf = function(a) {
        return "value" === a;
      };
      g.createEvent = function(a, b) {
        var c = b.n.g;
        return new Gb("value", this, new Q(a.Ja, b.Ib(), c));
      };
      g.Vb = function(a) {
        var b = this.rb;
        if ("cancel" === a.ze()) {
          K(this.pb, "Raising a cancel event on a listener with no cancel callback");
          var c = this.pb;
          return function() {
            c.call(b, a.error);
          };
        }
        var d = this.Rb;
        return function() {
          d.call(b, a.Zd);
        };
      };
      g.gf = function(a, b) {
        return this.pb ? new Hb(this, a, b) : null;
      };
      g.matches = function(a) {
        return a instanceof id ? a.Rb && this.Rb ? a.Rb === this.Rb && a.rb === this.rb : !0 : !1;
      };
      g.tf = function() {
        return null !== this.Rb;
      };
      function jd(a, b, c) {
        this.ha = a;
        this.pb = b;
        this.rb = c;
      }
      g = jd.prototype;
      g.Kf = function(a) {
        a = "children_added" === a ? "child_added" : a;
        return ("children_removed" === a ? "child_removed" : a) in this.ha;
      };
      g.gf = function(a, b) {
        return this.pb ? new Hb(this, a, b) : null;
      };
      g.createEvent = function(a, b) {
        K(null != a.Wa, "Child events should have a childName.");
        var c = b.Ib().u(a.Wa);
        return new Gb(a.type, this, new Q(a.Ja, c, b.n.g), a.Qd);
      };
      g.Vb = function(a) {
        var b = this.rb;
        if ("cancel" === a.ze()) {
          K(this.pb, "Raising a cancel event on a listener with no cancel callback");
          var c = this.pb;
          return function() {
            c.call(b, a.error);
          };
        }
        var d = this.ha[a.ud];
        return function() {
          d.call(b, a.Zd, a.Qd);
        };
      };
      g.matches = function(a) {
        if (a instanceof jd) {
          if (!this.ha || !a.ha)
            return !0;
          if (this.rb === a.rb) {
            var b = pa(a.ha);
            if (b === pa(this.ha)) {
              if (1 === b) {
                var b = qa(a.ha),
                    c = qa(this.ha);
                return c === b && (!a.ha[b] || !this.ha[c] || a.ha[b] === this.ha[c]);
              }
              return oa(this.ha, function(b, c) {
                return a.ha[c] === b;
              });
            }
          }
        }
        return !1;
      };
      g.tf = function() {
        return null !== this.ha;
      };
      function kd(a) {
        this.g = a;
      }
      g = kd.prototype;
      g.G = function(a, b, c, d, e, f) {
        K(a.Jc(this.g), "A node must be indexed if only a child is updated");
        e = a.R(b);
        if (e.Q(d).ca(c.Q(d)) && e.e() == c.e())
          return a;
        null != f && (c.e() ? a.Da(b) ? hd(f, new D("child_removed", e, b)) : K(a.K(), "A child remove without an old child only makes sense on a leaf node") : e.e() ? hd(f, new D("child_added", c, b)) : hd(f, new D("child_changed", c, b, e)));
        return a.K() && c.e() ? a : a.U(b, c).lb(this.g);
      };
      g.xa = function(a, b, c) {
        null != c && (a.K() || a.P(N, function(a, e) {
          b.Da(a) || hd(c, new D("child_removed", e, a));
        }), b.K() || b.P(N, function(b, e) {
          if (a.Da(b)) {
            var f = a.R(b);
            f.ca(e) || hd(c, new D("child_changed", e, b, f));
          } else
            hd(c, new D("child_added", e, b));
        }));
        return b.lb(this.g);
      };
      g.ga = function(a, b) {
        return a.e() ? C : a.ga(b);
      };
      g.Na = function() {
        return !1;
      };
      g.Wb = function() {
        return this;
      };
      function ld(a) {
        this.Be = new kd(a.g);
        this.g = a.g;
        var b;
        a.ma ? (b = md(a), b = a.g.Pc(nd(a), b)) : b = a.g.Tc();
        this.ed = b;
        a.pa ? (b = od(a), a = a.g.Pc(pd(a), b)) : a = a.g.Qc();
        this.Gc = a;
      }
      g = ld.prototype;
      g.matches = function(a) {
        return 0 >= this.g.compare(this.ed, a) && 0 >= this.g.compare(a, this.Gc);
      };
      g.G = function(a, b, c, d, e, f) {
        this.matches(new F(b, c)) || (c = C);
        return this.Be.G(a, b, c, d, e, f);
      };
      g.xa = function(a, b, c) {
        b.K() && (b = C);
        var d = b.lb(this.g),
            d = d.ga(C),
            e = this;
        b.P(N, function(a, b) {
          e.matches(new F(a, b)) || (d = d.U(a, C));
        });
        return this.Be.xa(a, d, c);
      };
      g.ga = function(a) {
        return a;
      };
      g.Na = function() {
        return !0;
      };
      g.Wb = function() {
        return this.Be;
      };
      function qd(a) {
        this.sa = new ld(a);
        this.g = a.g;
        K(a.ja, "Only valid if limit has been set");
        this.ka = a.ka;
        this.Jb = !rd(a);
      }
      g = qd.prototype;
      g.G = function(a, b, c, d, e, f) {
        this.sa.matches(new F(b, c)) || (c = C);
        return a.R(b).ca(c) ? a : a.Db() < this.ka ? this.sa.Wb().G(a, b, c, d, e, f) : sd(this, a, b, c, e, f);
      };
      g.xa = function(a, b, c) {
        var d;
        if (b.K() || b.e())
          d = C.lb(this.g);
        else if (2 * this.ka < b.Db() && b.Jc(this.g)) {
          d = C.lb(this.g);
          b = this.Jb ? b.$b(this.sa.Gc, this.g) : b.Yb(this.sa.ed, this.g);
          for (var e = 0; 0 < b.Pa.length && e < this.ka; ) {
            var f = J(b),
                h;
            if (h = this.Jb ? 0 >= this.g.compare(this.sa.ed, f) : 0 >= this.g.compare(f, this.sa.Gc))
              d = d.U(f.name, f.S), e++;
            else
              break;
          }
        } else {
          d = b.lb(this.g);
          d = d.ga(C);
          var k,
              l,
              m;
          if (this.Jb) {
            b = d.sf(this.g);
            k = this.sa.Gc;
            l = this.sa.ed;
            var t = td(this.g);
            m = function(a, b) {
              return t(b, a);
            };
          } else
            b = d.Xb(this.g), k = this.sa.ed, l = this.sa.Gc, m = td(this.g);
          for (var e = 0,
              z = !1; 0 < b.Pa.length; )
            f = J(b), !z && 0 >= m(k, f) && (z = !0), (h = z && e < this.ka && 0 >= m(f, l)) ? e++ : d = d.U(f.name, C);
        }
        return this.sa.Wb().xa(a, d, c);
      };
      g.ga = function(a) {
        return a;
      };
      g.Na = function() {
        return !0;
      };
      g.Wb = function() {
        return this.sa.Wb();
      };
      function sd(a, b, c, d, e, f) {
        var h;
        if (a.Jb) {
          var k = td(a.g);
          h = function(a, b) {
            return k(b, a);
          };
        } else
          h = td(a.g);
        K(b.Db() == a.ka, "");
        var l = new F(c, d),
            m = a.Jb ? ud(b, a.g) : vd(b, a.g),
            t = a.sa.matches(l);
        if (b.Da(c)) {
          for (var z = b.R(c),
              m = e.ye(a.g, m, a.Jb); null != m && (m.name == c || b.Da(m.name)); )
            m = e.ye(a.g, m, a.Jb);
          e = null == m ? 1 : h(m, l);
          if (t && !d.e() && 0 <= e)
            return null != f && hd(f, new D("child_changed", d, c, z)), b.U(c, d);
          null != f && hd(f, new D("child_removed", z, c));
          b = b.U(c, C);
          return null != m && a.sa.matches(m) ? (null != f && hd(f, new D("child_added", m.S, m.name)), b.U(m.name, m.S)) : b;
        }
        return d.e() ? b : t && 0 <= h(m, l) ? (null != f && (hd(f, new D("child_removed", m.S, m.name)), hd(f, new D("child_added", d, c))), b.U(c, d).U(m.name, C)) : b;
      }
      ;
      function wd(a, b) {
        this.je = a;
        this.fg = b;
      }
      function xd(a) {
        this.V = a;
      }
      xd.prototype.ab = function(a, b, c, d) {
        var e = new gd,
            f;
        if (b.type === Yb)
          b.source.we ? c = yd(this, a, b.path, b.Ga, c, d, e) : (K(b.source.pf, "Unknown source."), f = b.source.af || Jb(a.w()) && !b.path.e(), c = Ad(this, a, b.path, b.Ga, c, d, f, e));
        else if (b.type === Bd)
          b.source.we ? c = Cd(this, a, b.path, b.children, c, d, e) : (K(b.source.pf, "Unknown source."), f = b.source.af || Jb(a.w()), c = Dd(this, a, b.path, b.children, c, d, f, e));
        else if (b.type === Ed)
          if (b.Vd)
            if (b = b.path, null != c.tc(b))
              c = a;
            else {
              f = new rb(c, a, d);
              d = a.O.j();
              if (b.e() || ".priority" === E(b))
                Ib(a.w()) ? b = c.za(ub(a)) : (b = a.w().j(), K(b instanceof R, "serverChildren would be complete if leaf node"), b = c.yc(b)), b = this.V.xa(d, b, e);
              else {
                var h = E(b),
                    k = c.xc(h, a.w());
                null == k && sb(a.w(), h) && (k = d.R(h));
                b = null != k ? this.V.G(d, h, k, H(b), f, e) : a.O.j().Da(h) ? this.V.G(d, h, C, H(b), f, e) : d;
                b.e() && Ib(a.w()) && (d = c.za(ub(a)), d.K() && (b = this.V.xa(b, d, e)));
              }
              d = Ib(a.w()) || null != c.tc(G);
              c = Fd(a, b, d, this.V.Na());
            }
          else
            c = Gd(this, a, b.path, b.Qb, c, d, e);
        else if (b.type === $b)
          d = b.path, b = a.w(), f = b.j(), h = b.ea || d.e(), c = Hd(this, new Id(a.O, new tb(f, h, b.Ub)), d, c, qb, e);
        else
          throw Fc("Unknown operation type: " + b.type);
        e = ra(e.bb);
        d = c;
        b = d.O;
        b.ea && (f = b.j().K() || b.j().e(), h = Jd(a), (0 < e.length || !a.O.ea || f && !b.j().ca(h) || !b.j().C().ca(h.C())) && e.push(Eb(Jd(d))));
        return new wd(c, e);
      };
      function Hd(a, b, c, d, e, f) {
        var h = b.O;
        if (null != d.tc(c))
          return b;
        var k;
        if (c.e())
          K(Ib(b.w()), "If change path is empty, we must have complete server data"), Jb(b.w()) ? (e = ub(b), d = d.yc(e instanceof R ? e : C)) : d = d.za(ub(b)), f = a.V.xa(b.O.j(), d, f);
        else {
          var l = E(c);
          if (".priority" == l)
            K(1 == Kd(c), "Can't have a priority with additional path components"), f = h.j(), k = b.w().j(), d = d.ld(c, f, k), f = null != d ? a.V.ga(f, d) : h.j();
          else {
            var m = H(c);
            sb(h, l) ? (k = b.w().j(), d = d.ld(c, h.j(), k), d = null != d ? h.j().R(l).G(m, d) : h.j().R(l)) : d = d.xc(l, b.w());
            f = null != d ? a.V.G(h.j(), l, d, m, e, f) : h.j();
          }
        }
        return Fd(b, f, h.ea || c.e(), a.V.Na());
      }
      function Ad(a, b, c, d, e, f, h, k) {
        var l = b.w();
        h = h ? a.V : a.V.Wb();
        if (c.e())
          d = h.xa(l.j(), d, null);
        else if (h.Na() && !l.Ub)
          d = l.j().G(c, d), d = h.xa(l.j(), d, null);
        else {
          var m = E(c);
          if (!Kb(l, c) && 1 < Kd(c))
            return b;
          var t = H(c);
          d = l.j().R(m).G(t, d);
          d = ".priority" == m ? h.ga(l.j(), d) : h.G(l.j(), m, d, t, qb, null);
        }
        l = l.ea || c.e();
        b = new Id(b.O, new tb(d, l, h.Na()));
        return Hd(a, b, c, e, new rb(e, b, f), k);
      }
      function yd(a, b, c, d, e, f, h) {
        var k = b.O;
        e = new rb(e, b, f);
        if (c.e())
          h = a.V.xa(b.O.j(), d, h), a = Fd(b, h, !0, a.V.Na());
        else if (f = E(c), ".priority" === f)
          h = a.V.ga(b.O.j(), d), a = Fd(b, h, k.ea, k.Ub);
        else {
          c = H(c);
          var l = k.j().R(f);
          if (!c.e()) {
            var m = e.qf(f);
            d = null != m ? ".priority" === Ld(c) && m.Q(c.parent()).e() ? m : m.G(c, d) : C;
          }
          l.ca(d) ? a = b : (h = a.V.G(k.j(), f, d, c, e, h), a = Fd(b, h, k.ea, a.V.Na()));
        }
        return a;
      }
      function Cd(a, b, c, d, e, f, h) {
        var k = b;
        Md(d, function(d, m) {
          var t = c.u(d);
          sb(b.O, E(t)) && (k = yd(a, k, t, m, e, f, h));
        });
        Md(d, function(d, m) {
          var t = c.u(d);
          sb(b.O, E(t)) || (k = yd(a, k, t, m, e, f, h));
        });
        return k;
      }
      function Nd(a, b) {
        Md(b, function(b, d) {
          a = a.G(b, d);
        });
        return a;
      }
      function Dd(a, b, c, d, e, f, h, k) {
        if (b.w().j().e() && !Ib(b.w()))
          return b;
        var l = b;
        c = c.e() ? d : Od(Pd, c, d);
        var m = b.w().j();
        c.children.ia(function(c, d) {
          if (m.Da(c)) {
            var I = b.w().j().R(c),
                I = Nd(I, d);
            l = Ad(a, l, new L(c), I, e, f, h, k);
          }
        });
        c.children.ia(function(c, d) {
          var I = !sb(b.w(), c) && null == d.value;
          m.Da(c) || I || (I = b.w().j().R(c), I = Nd(I, d), l = Ad(a, l, new L(c), I, e, f, h, k));
        });
        return l;
      }
      function Gd(a, b, c, d, e, f, h) {
        if (null != e.tc(c))
          return b;
        var k = Jb(b.w()),
            l = b.w();
        if (null != d.value) {
          if (c.e() && l.ea || Kb(l, c))
            return Ad(a, b, c, l.j().Q(c), e, f, k, h);
          if (c.e()) {
            var m = Pd;
            l.j().P(Qd, function(a, b) {
              m = m.set(new L(a), b);
            });
            return Dd(a, b, c, m, e, f, k, h);
          }
          return b;
        }
        m = Pd;
        Md(d, function(a) {
          var b = c.u(a);
          Kb(l, b) && (m = m.set(a, l.j().Q(b)));
        });
        return Dd(a, b, c, m, e, f, k, h);
      }
      ;
      function Rd() {}
      var Sd = {};
      function td(a) {
        return q(a.compare, a);
      }
      Rd.prototype.Ad = function(a, b) {
        return 0 !== this.compare(new F("[MIN_NAME]", a), new F("[MIN_NAME]", b));
      };
      Rd.prototype.Tc = function() {
        return Td;
      };
      function Ud(a) {
        K(!a.e() && ".priority" !== E(a), "Can't create PathIndex with empty path or .priority key");
        this.cc = a;
      }
      ma(Ud, Rd);
      g = Ud.prototype;
      g.Ic = function(a) {
        return !a.Q(this.cc).e();
      };
      g.compare = function(a, b) {
        var c = a.S.Q(this.cc),
            d = b.S.Q(this.cc),
            c = c.Dc(d);
        return 0 === c ? Vb(a.name, b.name) : c;
      };
      g.Pc = function(a, b) {
        var c = M(a),
            c = C.G(this.cc, c);
        return new F(b, c);
      };
      g.Qc = function() {
        var a = C.G(this.cc, Vd);
        return new F("[MAX_NAME]", a);
      };
      g.toString = function() {
        return this.cc.slice().join("/");
      };
      function Wd() {}
      ma(Wd, Rd);
      g = Wd.prototype;
      g.compare = function(a, b) {
        var c = a.S.C(),
            d = b.S.C(),
            c = c.Dc(d);
        return 0 === c ? Vb(a.name, b.name) : c;
      };
      g.Ic = function(a) {
        return !a.C().e();
      };
      g.Ad = function(a, b) {
        return !a.C().ca(b.C());
      };
      g.Tc = function() {
        return Td;
      };
      g.Qc = function() {
        return new F("[MAX_NAME]", new tc("[PRIORITY-POST]", Vd));
      };
      g.Pc = function(a, b) {
        var c = M(a);
        return new F(b, new tc("[PRIORITY-POST]", c));
      };
      g.toString = function() {
        return ".priority";
      };
      var N = new Wd;
      function Xd() {}
      ma(Xd, Rd);
      g = Xd.prototype;
      g.compare = function(a, b) {
        return Vb(a.name, b.name);
      };
      g.Ic = function() {
        throw Fc("KeyIndex.isDefinedOn not expected to be called.");
      };
      g.Ad = function() {
        return !1;
      };
      g.Tc = function() {
        return Td;
      };
      g.Qc = function() {
        return new F("[MAX_NAME]", C);
      };
      g.Pc = function(a) {
        K(p(a), "KeyIndex indexValue must always be a string.");
        return new F(a, C);
      };
      g.toString = function() {
        return ".key";
      };
      var Qd = new Xd;
      function Yd() {}
      ma(Yd, Rd);
      g = Yd.prototype;
      g.compare = function(a, b) {
        var c = a.S.Dc(b.S);
        return 0 === c ? Vb(a.name, b.name) : c;
      };
      g.Ic = function() {
        return !0;
      };
      g.Ad = function(a, b) {
        return !a.ca(b);
      };
      g.Tc = function() {
        return Td;
      };
      g.Qc = function() {
        return Zd;
      };
      g.Pc = function(a, b) {
        var c = M(a);
        return new F(b, c);
      };
      g.toString = function() {
        return ".value";
      };
      var $d = new Yd;
      function ae() {
        this.Tb = this.pa = this.Lb = this.ma = this.ja = !1;
        this.ka = 0;
        this.Nb = "";
        this.ec = null;
        this.xb = "";
        this.bc = null;
        this.vb = "";
        this.g = N;
      }
      var be = new ae;
      function rd(a) {
        return "" === a.Nb ? a.ma : "l" === a.Nb;
      }
      function nd(a) {
        K(a.ma, "Only valid if start has been set");
        return a.ec;
      }
      function md(a) {
        K(a.ma, "Only valid if start has been set");
        return a.Lb ? a.xb : "[MIN_NAME]";
      }
      function pd(a) {
        K(a.pa, "Only valid if end has been set");
        return a.bc;
      }
      function od(a) {
        K(a.pa, "Only valid if end has been set");
        return a.Tb ? a.vb : "[MAX_NAME]";
      }
      function ce(a) {
        var b = new ae;
        b.ja = a.ja;
        b.ka = a.ka;
        b.ma = a.ma;
        b.ec = a.ec;
        b.Lb = a.Lb;
        b.xb = a.xb;
        b.pa = a.pa;
        b.bc = a.bc;
        b.Tb = a.Tb;
        b.vb = a.vb;
        b.g = a.g;
        return b;
      }
      g = ae.prototype;
      g.He = function(a) {
        var b = ce(this);
        b.ja = !0;
        b.ka = a;
        b.Nb = "";
        return b;
      };
      g.Ie = function(a) {
        var b = ce(this);
        b.ja = !0;
        b.ka = a;
        b.Nb = "l";
        return b;
      };
      g.Je = function(a) {
        var b = ce(this);
        b.ja = !0;
        b.ka = a;
        b.Nb = "r";
        return b;
      };
      g.$d = function(a, b) {
        var c = ce(this);
        c.ma = !0;
        n(a) || (a = null);
        c.ec = a;
        null != b ? (c.Lb = !0, c.xb = b) : (c.Lb = !1, c.xb = "");
        return c;
      };
      g.td = function(a, b) {
        var c = ce(this);
        c.pa = !0;
        n(a) || (a = null);
        c.bc = a;
        n(b) ? (c.Tb = !0, c.vb = b) : (c.ah = !1, c.vb = "");
        return c;
      };
      function de(a, b) {
        var c = ce(a);
        c.g = b;
        return c;
      }
      function ee(a) {
        var b = {};
        a.ma && (b.sp = a.ec, a.Lb && (b.sn = a.xb));
        a.pa && (b.ep = a.bc, a.Tb && (b.en = a.vb));
        if (a.ja) {
          b.l = a.ka;
          var c = a.Nb;
          "" === c && (c = rd(a) ? "l" : "r");
          b.vf = c;
        }
        a.g !== N && (b.i = a.g.toString());
        return b;
      }
      function S(a) {
        return !(a.ma || a.pa || a.ja);
      }
      function fe(a) {
        return S(a) && a.g == N;
      }
      function ge(a) {
        var b = {};
        if (fe(a))
          return b;
        var c;
        a.g === N ? c = "$priority" : a.g === $d ? c = "$value" : a.g === Qd ? c = "$key" : (K(a.g instanceof Ud, "Unrecognized index type!"), c = a.g.toString());
        b.orderBy = B(c);
        a.ma && (b.startAt = B(a.ec), a.Lb && (b.startAt += "," + B(a.xb)));
        a.pa && (b.endAt = B(a.bc), a.Tb && (b.endAt += "," + B(a.vb)));
        a.ja && (rd(a) ? b.limitToFirst = a.ka : b.limitToLast = a.ka);
        return b;
      }
      g.toString = function() {
        return B(ee(this));
      };
      function he(a, b) {
        this.Bd = a;
        this.dc = b;
      }
      he.prototype.get = function(a) {
        var b = w(this.Bd, a);
        if (!b)
          throw Error("No index defined for " + a);
        return b === Sd ? null : b;
      };
      function ie(a, b, c) {
        var d = na(a.Bd, function(d, f) {
          var h = w(a.dc, f);
          K(h, "Missing index implementation for " + f);
          if (d === Sd) {
            if (h.Ic(b.S)) {
              for (var k = [],
                  l = c.Xb(Tb),
                  m = J(l); m; )
                m.name != b.name && k.push(m), m = J(l);
              k.push(b);
              return je(k, td(h));
            }
            return Sd;
          }
          h = c.get(b.name);
          k = d;
          h && (k = k.remove(new F(b.name, h)));
          return k.Oa(b, b.S);
        });
        return new he(d, a.dc);
      }
      function ke(a, b, c) {
        var d = na(a.Bd, function(a) {
          if (a === Sd)
            return a;
          var d = c.get(b.name);
          return d ? a.remove(new F(b.name, d)) : a;
        });
        return new he(d, a.dc);
      }
      var le = new he({".priority": Sd}, {".priority": N});
      function tc(a, b) {
        this.B = a;
        K(n(this.B) && null !== this.B, "LeafNode shouldn't be created with null/undefined value.");
        this.aa = b || C;
        me(this.aa);
        this.Cb = null;
      }
      var ne = ["object", "boolean", "number", "string"];
      g = tc.prototype;
      g.K = function() {
        return !0;
      };
      g.C = function() {
        return this.aa;
      };
      g.ga = function(a) {
        return new tc(this.B, a);
      };
      g.R = function(a) {
        return ".priority" === a ? this.aa : C;
      };
      g.Q = function(a) {
        return a.e() ? this : ".priority" === E(a) ? this.aa : C;
      };
      g.Da = function() {
        return !1;
      };
      g.rf = function() {
        return null;
      };
      g.U = function(a, b) {
        return ".priority" === a ? this.ga(b) : b.e() && ".priority" !== a ? this : C.U(a, b).ga(this.aa);
      };
      g.G = function(a, b) {
        var c = E(a);
        if (null === c)
          return b;
        if (b.e() && ".priority" !== c)
          return this;
        K(".priority" !== c || 1 === Kd(a), ".priority must be the last token in a path");
        return this.U(c, C.G(H(a), b));
      };
      g.e = function() {
        return !1;
      };
      g.Db = function() {
        return 0;
      };
      g.P = function() {
        return !1;
      };
      g.I = function(a) {
        return a && !this.C().e() ? {
          ".value": this.Ca(),
          ".priority": this.C().I()
        } : this.Ca();
      };
      g.hash = function() {
        if (null === this.Cb) {
          var a = "";
          this.aa.e() || (a += "priority:" + oe(this.aa.I()) + ":");
          var b = typeof this.B,
              a = a + (b + ":"),
              a = "number" === b ? a + Xc(this.B) : a + this.B;
          this.Cb = Hc(a);
        }
        return this.Cb;
      };
      g.Ca = function() {
        return this.B;
      };
      g.Dc = function(a) {
        if (a === C)
          return 1;
        if (a instanceof R)
          return -1;
        K(a.K(), "Unknown node type");
        var b = typeof a.B,
            c = typeof this.B,
            d = Na(ne, b),
            e = Na(ne, c);
        K(0 <= d, "Unknown leaf type: " + b);
        K(0 <= e, "Unknown leaf type: " + c);
        return d === e ? "object" === c ? 0 : this.B < a.B ? -1 : this.B === a.B ? 0 : 1 : e - d;
      };
      g.lb = function() {
        return this;
      };
      g.Jc = function() {
        return !0;
      };
      g.ca = function(a) {
        return a === this ? !0 : a.K() ? this.B === a.B && this.aa.ca(a.aa) : !1;
      };
      g.toString = function() {
        return B(this.I(!0));
      };
      function R(a, b, c) {
        this.m = a;
        (this.aa = b) && me(this.aa);
        a.e() && K(!this.aa || this.aa.e(), "An empty node cannot have a priority");
        this.wb = c;
        this.Cb = null;
      }
      g = R.prototype;
      g.K = function() {
        return !1;
      };
      g.C = function() {
        return this.aa || C;
      };
      g.ga = function(a) {
        return this.m.e() ? this : new R(this.m, a, this.wb);
      };
      g.R = function(a) {
        if (".priority" === a)
          return this.C();
        a = this.m.get(a);
        return null === a ? C : a;
      };
      g.Q = function(a) {
        var b = E(a);
        return null === b ? this : this.R(b).Q(H(a));
      };
      g.Da = function(a) {
        return null !== this.m.get(a);
      };
      g.U = function(a, b) {
        K(b, "We should always be passing snapshot nodes");
        if (".priority" === a)
          return this.ga(b);
        var c = new F(a, b),
            d,
            e;
        b.e() ? (d = this.m.remove(a), c = ke(this.wb, c, this.m)) : (d = this.m.Oa(a, b), c = ie(this.wb, c, this.m));
        e = d.e() ? C : this.aa;
        return new R(d, e, c);
      };
      g.G = function(a, b) {
        var c = E(a);
        if (null === c)
          return b;
        K(".priority" !== E(a) || 1 === Kd(a), ".priority must be the last token in a path");
        var d = this.R(c).G(H(a), b);
        return this.U(c, d);
      };
      g.e = function() {
        return this.m.e();
      };
      g.Db = function() {
        return this.m.count();
      };
      var pe = /^(0|[1-9]\d*)$/;
      g = R.prototype;
      g.I = function(a) {
        if (this.e())
          return null;
        var b = {},
            c = 0,
            d = 0,
            e = !0;
        this.P(N, function(f, h) {
          b[f] = h.I(a);
          c++;
          e && pe.test(f) ? d = Math.max(d, Number(f)) : e = !1;
        });
        if (!a && e && d < 2 * c) {
          var f = [],
              h;
          for (h in b)
            f[h] = b[h];
          return f;
        }
        a && !this.C().e() && (b[".priority"] = this.C().I());
        return b;
      };
      g.hash = function() {
        if (null === this.Cb) {
          var a = "";
          this.C().e() || (a += "priority:" + oe(this.C().I()) + ":");
          this.P(N, function(b, c) {
            var d = c.hash();
            "" !== d && (a += ":" + b + ":" + d);
          });
          this.Cb = "" === a ? "" : Hc(a);
        }
        return this.Cb;
      };
      g.rf = function(a, b, c) {
        return (c = qe(this, c)) ? (a = cc(c, new F(a, b))) ? a.name : null : cc(this.m, a);
      };
      function ud(a, b) {
        var c;
        c = (c = qe(a, b)) ? (c = c.Sc()) && c.name : a.m.Sc();
        return c ? new F(c, a.m.get(c)) : null;
      }
      function vd(a, b) {
        var c;
        c = (c = qe(a, b)) ? (c = c.fc()) && c.name : a.m.fc();
        return c ? new F(c, a.m.get(c)) : null;
      }
      g.P = function(a, b) {
        var c = qe(this, a);
        return c ? c.ia(function(a) {
          return b(a.name, a.S);
        }) : this.m.ia(b);
      };
      g.Xb = function(a) {
        return this.Yb(a.Tc(), a);
      };
      g.Yb = function(a, b) {
        var c = qe(this, b);
        if (c)
          return c.Yb(a, function(a) {
            return a;
          });
        for (var c = this.m.Yb(a.name, Tb),
            d = ec(c); null != d && 0 > b.compare(d, a); )
          J(c), d = ec(c);
        return c;
      };
      g.sf = function(a) {
        return this.$b(a.Qc(), a);
      };
      g.$b = function(a, b) {
        var c = qe(this, b);
        if (c)
          return c.$b(a, function(a) {
            return a;
          });
        for (var c = this.m.$b(a.name, Tb),
            d = ec(c); null != d && 0 < b.compare(d, a); )
          J(c), d = ec(c);
        return c;
      };
      g.Dc = function(a) {
        return this.e() ? a.e() ? 0 : -1 : a.K() || a.e() ? 1 : a === Vd ? -1 : 0;
      };
      g.lb = function(a) {
        if (a === Qd || ta(this.wb.dc, a.toString()))
          return this;
        var b = this.wb,
            c = this.m;
        K(a !== Qd, "KeyIndex always exists and isn't meant to be added to the IndexMap.");
        for (var d = [],
            e = !1,
            c = c.Xb(Tb),
            f = J(c); f; )
          e = e || a.Ic(f.S), d.push(f), f = J(c);
        d = e ? je(d, td(a)) : Sd;
        e = a.toString();
        c = xa(b.dc);
        c[e] = a;
        a = xa(b.Bd);
        a[e] = d;
        return new R(this.m, this.aa, new he(a, c));
      };
      g.Jc = function(a) {
        return a === Qd || ta(this.wb.dc, a.toString());
      };
      g.ca = function(a) {
        if (a === this)
          return !0;
        if (a.K())
          return !1;
        if (this.C().ca(a.C()) && this.m.count() === a.m.count()) {
          var b = this.Xb(N);
          a = a.Xb(N);
          for (var c = J(b),
              d = J(a); c && d; ) {
            if (c.name !== d.name || !c.S.ca(d.S))
              return !1;
            c = J(b);
            d = J(a);
          }
          return null === c && null === d;
        }
        return !1;
      };
      function qe(a, b) {
        return b === Qd ? null : a.wb.get(b.toString());
      }
      g.toString = function() {
        return B(this.I(!0));
      };
      function M(a, b) {
        if (null === a)
          return C;
        var c = null;
        "object" === typeof a && ".priority" in a ? c = a[".priority"] : "undefined" !== typeof b && (c = b);
        K(null === c || "string" === typeof c || "number" === typeof c || "object" === typeof c && ".sv" in c, "Invalid priority type found: " + typeof c);
        "object" === typeof a && ".value" in a && null !== a[".value"] && (a = a[".value"]);
        if ("object" !== typeof a || ".sv" in a)
          return new tc(a, M(c));
        if (a instanceof Array) {
          var d = C,
              e = a;
          r(e, function(a, b) {
            if (v(e, b) && "." !== b.substring(0, 1)) {
              var c = M(a);
              if (c.K() || !c.e())
                d = d.U(b, c);
            }
          });
          return d.ga(M(c));
        }
        var f = [],
            h = !1,
            k = a;
        ib(k, function(a) {
          if ("string" !== typeof a || "." !== a.substring(0, 1)) {
            var b = M(k[a]);
            b.e() || (h = h || !b.C().e(), f.push(new F(a, b)));
          }
        });
        if (0 == f.length)
          return C;
        var l = je(f, Ub, function(a) {
          return a.name;
        }, Wb);
        if (h) {
          var m = je(f, td(N));
          return new R(l, M(c), new he({".priority": m}, {".priority": N}));
        }
        return new R(l, M(c), le);
      }
      var re = Math.log(2);
      function se(a) {
        this.count = parseInt(Math.log(a + 1) / re, 10);
        this.jf = this.count - 1;
        this.eg = a + 1 & parseInt(Array(this.count + 1).join("1"), 2);
      }
      function te(a) {
        var b = !(a.eg & 1 << a.jf);
        a.jf--;
        return b;
      }
      function je(a, b, c, d) {
        function e(b, d) {
          var f = d - b;
          if (0 == f)
            return null;
          if (1 == f) {
            var m = a[b],
                t = c ? c(m) : m;
            return new fc(t, m.S, !1, null, null);
          }
          var m = parseInt(f / 2, 10) + b,
              f = e(b, m),
              z = e(m + 1, d),
              m = a[m],
              t = c ? c(m) : m;
          return new fc(t, m.S, !1, f, z);
        }
        a.sort(b);
        var f = function(b) {
          function d(b, h) {
            var k = t - b,
                z = t;
            t -= b;
            var z = e(k + 1, z),
                k = a[k],
                I = c ? c(k) : k,
                z = new fc(I, k.S, h, null, z);
            f ? f.left = z : m = z;
            f = z;
          }
          for (var f = null,
              m = null,
              t = a.length,
              z = 0; z < b.count; ++z) {
            var I = te(b),
                zd = Math.pow(2, b.count - (z + 1));
            I ? d(zd, !1) : (d(zd, !1), d(zd, !0));
          }
          return m;
        }(new se(a.length));
        return null !== f ? new ac(d || b, f) : new ac(d || b);
      }
      function oe(a) {
        return "number" === typeof a ? "number:" + Xc(a) : "string:" + a;
      }
      function me(a) {
        if (a.K()) {
          var b = a.I();
          K("string" === typeof b || "number" === typeof b || "object" === typeof b && v(b, ".sv"), "Priority must be a string or number.");
        } else
          K(a === Vd || a.e(), "priority of unexpected type.");
        K(a === Vd || a.C().e(), "Priority nodes can't have a priority of their own.");
      }
      var C = new R(new ac(Wb), null, le);
      function ue() {
        R.call(this, new ac(Wb), C, le);
      }
      ma(ue, R);
      g = ue.prototype;
      g.Dc = function(a) {
        return a === this ? 0 : 1;
      };
      g.ca = function(a) {
        return a === this;
      };
      g.C = function() {
        return this;
      };
      g.R = function() {
        return C;
      };
      g.e = function() {
        return !1;
      };
      var Vd = new ue,
          Td = new F("[MIN_NAME]", C),
          Zd = new F("[MAX_NAME]", Vd);
      function Id(a, b) {
        this.O = a;
        this.Yd = b;
      }
      function Fd(a, b, c, d) {
        return new Id(new tb(b, c, d), a.Yd);
      }
      function Jd(a) {
        return a.O.ea ? a.O.j() : null;
      }
      Id.prototype.w = function() {
        return this.Yd;
      };
      function ub(a) {
        return a.Yd.ea ? a.Yd.j() : null;
      }
      ;
      function ve(a, b) {
        this.W = a;
        var c = a.n,
            d = new kd(c.g),
            c = S(c) ? new kd(c.g) : c.ja ? new qd(c) : new ld(c);
        this.Hf = new xd(c);
        var e = b.w(),
            f = b.O,
            h = d.xa(C, e.j(), null),
            k = c.xa(C, f.j(), null);
        this.Ka = new Id(new tb(k, f.ea, c.Na()), new tb(h, e.ea, d.Na()));
        this.Xa = [];
        this.lg = new cd(a);
      }
      function we(a) {
        return a.W;
      }
      g = ve.prototype;
      g.w = function() {
        return this.Ka.w().j();
      };
      g.fb = function(a) {
        var b = ub(this.Ka);
        return b && (S(this.W.n) || !a.e() && !b.R(E(a)).e()) ? b.Q(a) : null;
      };
      g.e = function() {
        return 0 === this.Xa.length;
      };
      g.Pb = function(a) {
        this.Xa.push(a);
      };
      g.jb = function(a, b) {
        var c = [];
        if (b) {
          K(null == a, "A cancel should cancel all event registrations.");
          var d = this.W.path;
          Oa(this.Xa, function(a) {
            (a = a.gf(b, d)) && c.push(a);
          });
        }
        if (a) {
          for (var e = [],
              f = 0; f < this.Xa.length; ++f) {
            var h = this.Xa[f];
            if (!h.matches(a))
              e.push(h);
            else if (a.tf()) {
              e = e.concat(this.Xa.slice(f + 1));
              break;
            }
          }
          this.Xa = e;
        } else
          this.Xa = [];
        return c;
      };
      g.ab = function(a, b, c) {
        a.type === Bd && null !== a.source.Hb && (K(ub(this.Ka), "We should always have a full cache before handling merges"), K(Jd(this.Ka), "Missing event cache, even though we have a server cache"));
        var d = this.Ka;
        a = this.Hf.ab(d, a, b, c);
        b = this.Hf;
        c = a.je;
        K(c.O.j().Jc(b.V.g), "Event snap not indexed");
        K(c.w().j().Jc(b.V.g), "Server snap not indexed");
        K(Ib(a.je.w()) || !Ib(d.w()), "Once a server snap is complete, it should never go back");
        this.Ka = a.je;
        return xe(this, a.fg, a.je.O.j(), null);
      };
      function ye(a, b) {
        var c = a.Ka.O,
            d = [];
        c.j().K() || c.j().P(N, function(a, b) {
          d.push(new D("child_added", b, a));
        });
        c.ea && d.push(Eb(c.j()));
        return xe(a, d, c.j(), b);
      }
      function xe(a, b, c, d) {
        return dd(a.lg, b, c, d ? [d] : a.Xa);
      }
      ;
      function ze(a, b, c) {
        this.type = Bd;
        this.source = a;
        this.path = b;
        this.children = c;
      }
      ze.prototype.Xc = function(a) {
        if (this.path.e())
          return a = this.children.subtree(new L(a)), a.e() ? null : a.value ? new Xb(this.source, G, a.value) : new ze(this.source, G, a);
        K(E(this.path) === a, "Can't get a merge for a child not on the path of the operation");
        return new ze(this.source, H(this.path), this.children);
      };
      ze.prototype.toString = function() {
        return "Operation(" + this.path + ": " + this.source.toString() + " merge: " + this.children.toString() + ")";
      };
      function Ae(a, b) {
        this.f = Mc("p:rest:");
        this.F = a;
        this.Gb = b;
        this.Aa = null;
        this.$ = {};
      }
      function Be(a, b) {
        if (n(b))
          return "tag$" + b;
        K(fe(a.n), "should have a tag if it's not a default query.");
        return a.path.toString();
      }
      g = Ae.prototype;
      g.yf = function(a, b, c, d) {
        var e = a.path.toString();
        this.f("Listen called for " + e + " " + a.va());
        var f = Be(a, c),
            h = {};
        this.$[f] = h;
        a = ge(a.n);
        var k = this;
        Ce(this, e + ".json", a, function(a, b) {
          var t = b;
          404 === a && (a = t = null);
          null === a && k.Gb(e, t, !1, c);
          w(k.$, f) === h && d(a ? 401 == a ? "permission_denied" : "rest_error:" + a : "ok", null);
        });
      };
      g.Rf = function(a, b) {
        var c = Be(a, b);
        delete this.$[c];
      };
      g.M = function(a, b) {
        this.Aa = a;
        var c = $c(a),
            d = c.data,
            c = c.Bc && c.Bc.exp;
        b && b("ok", {
          auth: d,
          expires: c
        });
      };
      g.ge = function(a) {
        this.Aa = null;
        a("ok", null);
      };
      g.Me = function() {};
      g.Cf = function() {};
      g.Jd = function() {};
      g.put = function() {};
      g.zf = function() {};
      g.Ue = function() {};
      function Ce(a, b, c, d) {
        c = c || {};
        c.format = "export";
        a.Aa && (c.auth = a.Aa);
        var e = (a.F.kb ? "https://" : "http://") + a.F.host + b + "?" + kb(c);
        a.f("Sending REST request for " + e);
        var f = new XMLHttpRequest;
        f.onreadystatechange = function() {
          if (d && 4 === f.readyState) {
            a.f("REST Response for " + e + " received. status:", f.status, "response:", f.responseText);
            var b = null;
            if (200 <= f.status && 300 > f.status) {
              try {
                b = nb(f.responseText);
              } catch (c) {
                O("Failed to parse JSON response for " + e + ": " + f.responseText);
              }
              d(null, b);
            } else
              401 !== f.status && 404 !== f.status && O("Got unsuccessful REST response for " + e + " Status: " + f.status), d(f.status);
            d = null;
          }
        };
        f.open("GET", e, !0);
        f.send();
      }
      ;
      function De(a) {
        K(ea(a) && 0 < a.length, "Requires a non-empty array");
        this.Xf = a;
        this.Oc = {};
      }
      De.prototype.fe = function(a, b) {
        var c;
        c = this.Oc[a] || [];
        var d = c.length;
        if (0 < d) {
          for (var e = Array(d),
              f = 0; f < d; f++)
            e[f] = c[f];
          c = e;
        } else
          c = [];
        for (d = 0; d < c.length; d++)
          c[d].zc.apply(c[d].Ma, Array.prototype.slice.call(arguments, 1));
      };
      De.prototype.Eb = function(a, b, c) {
        Ee(this, a);
        this.Oc[a] = this.Oc[a] || [];
        this.Oc[a].push({
          zc: b,
          Ma: c
        });
        (a = this.Ae(a)) && b.apply(c, a);
      };
      De.prototype.ic = function(a, b, c) {
        Ee(this, a);
        a = this.Oc[a] || [];
        for (var d = 0; d < a.length; d++)
          if (a[d].zc === b && (!c || c === a[d].Ma)) {
            a.splice(d, 1);
            break;
          }
      };
      function Ee(a, b) {
        K(Ta(a.Xf, function(a) {
          return a === b;
        }), "Unknown event: " + b);
      }
      ;
      var Fe = function() {
        var a = 0,
            b = [];
        return function(c) {
          var d = c === a;
          a = c;
          for (var e = Array(8),
              f = 7; 0 <= f; f--)
            e[f] = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz".charAt(c % 64), c = Math.floor(c / 64);
          K(0 === c, "Cannot push at time == 0");
          c = e.join("");
          if (d) {
            for (f = 11; 0 <= f && 63 === b[f]; f--)
              b[f] = 0;
            b[f]++;
          } else
            for (f = 0; 12 > f; f++)
              b[f] = Math.floor(64 * Math.random());
          for (f = 0; 12 > f; f++)
            c += "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz".charAt(b[f]);
          K(20 === c.length, "nextPushId: Length should be 20.");
          return c;
        };
      }();
      function Ge() {
        De.call(this, ["online"]);
        this.kc = !0;
        if ("undefined" !== typeof window && "undefined" !== typeof window.addEventListener) {
          var a = this;
          window.addEventListener("online", function() {
            a.kc || (a.kc = !0, a.fe("online", !0));
          }, !1);
          window.addEventListener("offline", function() {
            a.kc && (a.kc = !1, a.fe("online", !1));
          }, !1);
        }
      }
      ma(Ge, De);
      Ge.prototype.Ae = function(a) {
        K("online" === a, "Unknown event type: " + a);
        return [this.kc];
      };
      ca(Ge);
      function He() {
        De.call(this, ["visible"]);
        var a,
            b;
        "undefined" !== typeof document && "undefined" !== typeof document.addEventListener && ("undefined" !== typeof document.hidden ? (b = "visibilitychange", a = "hidden") : "undefined" !== typeof document.mozHidden ? (b = "mozvisibilitychange", a = "mozHidden") : "undefined" !== typeof document.msHidden ? (b = "msvisibilitychange", a = "msHidden") : "undefined" !== typeof document.webkitHidden && (b = "webkitvisibilitychange", a = "webkitHidden"));
        this.Ob = !0;
        if (b) {
          var c = this;
          document.addEventListener(b, function() {
            var b = !document[a];
            b !== c.Ob && (c.Ob = b, c.fe("visible", b));
          }, !1);
        }
      }
      ma(He, De);
      He.prototype.Ae = function(a) {
        K("visible" === a, "Unknown event type: " + a);
        return [this.Ob];
      };
      ca(He);
      function L(a, b) {
        if (1 == arguments.length) {
          this.o = a.split("/");
          for (var c = 0,
              d = 0; d < this.o.length; d++)
            0 < this.o[d].length && (this.o[c] = this.o[d], c++);
          this.o.length = c;
          this.Z = 0;
        } else
          this.o = a, this.Z = b;
      }
      function T(a, b) {
        var c = E(a);
        if (null === c)
          return b;
        if (c === E(b))
          return T(H(a), H(b));
        throw Error("INTERNAL ERROR: innerPath (" + b + ") is not within outerPath (" + a + ")");
      }
      function Ie(a, b) {
        for (var c = a.slice(),
            d = b.slice(),
            e = 0; e < c.length && e < d.length; e++) {
          var f = Vb(c[e], d[e]);
          if (0 !== f)
            return f;
        }
        return c.length === d.length ? 0 : c.length < d.length ? -1 : 1;
      }
      function E(a) {
        return a.Z >= a.o.length ? null : a.o[a.Z];
      }
      function Kd(a) {
        return a.o.length - a.Z;
      }
      function H(a) {
        var b = a.Z;
        b < a.o.length && b++;
        return new L(a.o, b);
      }
      function Ld(a) {
        return a.Z < a.o.length ? a.o[a.o.length - 1] : null;
      }
      g = L.prototype;
      g.toString = function() {
        for (var a = "",
            b = this.Z; b < this.o.length; b++)
          "" !== this.o[b] && (a += "/" + this.o[b]);
        return a || "/";
      };
      g.slice = function(a) {
        return this.o.slice(this.Z + (a || 0));
      };
      g.parent = function() {
        if (this.Z >= this.o.length)
          return null;
        for (var a = [],
            b = this.Z; b < this.o.length - 1; b++)
          a.push(this.o[b]);
        return new L(a, 0);
      };
      g.u = function(a) {
        for (var b = [],
            c = this.Z; c < this.o.length; c++)
          b.push(this.o[c]);
        if (a instanceof L)
          for (c = a.Z; c < a.o.length; c++)
            b.push(a.o[c]);
        else
          for (a = a.split("/"), c = 0; c < a.length; c++)
            0 < a[c].length && b.push(a[c]);
        return new L(b, 0);
      };
      g.e = function() {
        return this.Z >= this.o.length;
      };
      g.ca = function(a) {
        if (Kd(this) !== Kd(a))
          return !1;
        for (var b = this.Z,
            c = a.Z; b <= this.o.length; b++, c++)
          if (this.o[b] !== a.o[c])
            return !1;
        return !0;
      };
      g.contains = function(a) {
        var b = this.Z,
            c = a.Z;
        if (Kd(this) > Kd(a))
          return !1;
        for (; b < this.o.length; ) {
          if (this.o[b] !== a.o[c])
            return !1;
          ++b;
          ++c;
        }
        return !0;
      };
      var G = new L("");
      function Je(a, b) {
        this.Qa = a.slice();
        this.Ha = Math.max(1, this.Qa.length);
        this.lf = b;
        for (var c = 0; c < this.Qa.length; c++)
          this.Ha += Zc(this.Qa[c]);
        Ke(this);
      }
      Je.prototype.push = function(a) {
        0 < this.Qa.length && (this.Ha += 1);
        this.Qa.push(a);
        this.Ha += Zc(a);
        Ke(this);
      };
      Je.prototype.pop = function() {
        var a = this.Qa.pop();
        this.Ha -= Zc(a);
        0 < this.Qa.length && --this.Ha;
      };
      function Ke(a) {
        if (768 < a.Ha)
          throw Error(a.lf + "has a key path longer than 768 bytes (" + a.Ha + ").");
        if (32 < a.Qa.length)
          throw Error(a.lf + "path specified exceeds the maximum depth that can be written (32) or object contains a cycle " + Le(a));
      }
      function Le(a) {
        return 0 == a.Qa.length ? "" : "in property '" + a.Qa.join(".") + "'";
      }
      ;
      function Me(a, b) {
        this.value = a;
        this.children = b || Ne;
      }
      var Ne = new ac(function(a, b) {
        return a === b ? 0 : a < b ? -1 : 1;
      });
      function Oe(a) {
        var b = Pd;
        r(a, function(a, d) {
          b = b.set(new L(d), a);
        });
        return b;
      }
      g = Me.prototype;
      g.e = function() {
        return null === this.value && this.children.e();
      };
      function Pe(a, b, c) {
        if (null != a.value && c(a.value))
          return {
            path: G,
            value: a.value
          };
        if (b.e())
          return null;
        var d = E(b);
        a = a.children.get(d);
        return null !== a ? (b = Pe(a, H(b), c), null != b ? {
          path: (new L(d)).u(b.path),
          value: b.value
        } : null) : null;
      }
      function Qe(a, b) {
        return Pe(a, b, function() {
          return !0;
        });
      }
      g.subtree = function(a) {
        if (a.e())
          return this;
        var b = this.children.get(E(a));
        return null !== b ? b.subtree(H(a)) : Pd;
      };
      g.set = function(a, b) {
        if (a.e())
          return new Me(b, this.children);
        var c = E(a),
            d = (this.children.get(c) || Pd).set(H(a), b),
            c = this.children.Oa(c, d);
        return new Me(this.value, c);
      };
      g.remove = function(a) {
        if (a.e())
          return this.children.e() ? Pd : new Me(null, this.children);
        var b = E(a),
            c = this.children.get(b);
        return c ? (a = c.remove(H(a)), b = a.e() ? this.children.remove(b) : this.children.Oa(b, a), null === this.value && b.e() ? Pd : new Me(this.value, b)) : this;
      };
      g.get = function(a) {
        if (a.e())
          return this.value;
        var b = this.children.get(E(a));
        return b ? b.get(H(a)) : null;
      };
      function Od(a, b, c) {
        if (b.e())
          return c;
        var d = E(b);
        b = Od(a.children.get(d) || Pd, H(b), c);
        d = b.e() ? a.children.remove(d) : a.children.Oa(d, b);
        return new Me(a.value, d);
      }
      function Re(a, b) {
        return Se(a, G, b);
      }
      function Se(a, b, c) {
        var d = {};
        a.children.ia(function(a, f) {
          d[a] = Se(f, b.u(a), c);
        });
        return c(b, a.value, d);
      }
      function Te(a, b, c) {
        return Ue(a, b, G, c);
      }
      function Ue(a, b, c, d) {
        var e = a.value ? d(c, a.value) : !1;
        if (e)
          return e;
        if (b.e())
          return null;
        e = E(b);
        return (a = a.children.get(e)) ? Ue(a, H(b), c.u(e), d) : null;
      }
      function Ve(a, b, c) {
        var d = G;
        if (!b.e()) {
          var e = !0;
          a.value && (e = c(d, a.value));
          !0 === e && (e = E(b), (a = a.children.get(e)) && We(a, H(b), d.u(e), c));
        }
      }
      function We(a, b, c, d) {
        if (b.e())
          return a;
        a.value && d(c, a.value);
        var e = E(b);
        return (a = a.children.get(e)) ? We(a, H(b), c.u(e), d) : Pd;
      }
      function Md(a, b) {
        Xe(a, G, b);
      }
      function Xe(a, b, c) {
        a.children.ia(function(a, e) {
          Xe(e, b.u(a), c);
        });
        a.value && c(b, a.value);
      }
      function Ye(a, b) {
        a.children.ia(function(a, d) {
          d.value && b(a, d.value);
        });
      }
      var Pd = new Me(null);
      Me.prototype.toString = function() {
        var a = {};
        Md(this, function(b, c) {
          a[b.toString()] = c.toString();
        });
        return B(a);
      };
      function Ze(a, b, c) {
        this.type = Ed;
        this.source = $e;
        this.path = a;
        this.Qb = b;
        this.Vd = c;
      }
      Ze.prototype.Xc = function(a) {
        if (this.path.e()) {
          if (null != this.Qb.value)
            return K(this.Qb.children.e(), "affectedTree should not have overlapping affected paths."), this;
          a = this.Qb.subtree(new L(a));
          return new Ze(G, a, this.Vd);
        }
        K(E(this.path) === a, "operationForChild called for unrelated child.");
        return new Ze(H(this.path), this.Qb, this.Vd);
      };
      Ze.prototype.toString = function() {
        return "Operation(" + this.path + ": " + this.source.toString() + " ack write revert=" + this.Vd + " affectedTree=" + this.Qb + ")";
      };
      var Yb = 0,
          Bd = 1,
          Ed = 2,
          $b = 3;
      function af(a, b, c, d) {
        this.we = a;
        this.pf = b;
        this.Hb = c;
        this.af = d;
        K(!d || b, "Tagged queries must be from server.");
      }
      var $e = new af(!0, !1, null, !1),
          bf = new af(!1, !0, null, !1);
      af.prototype.toString = function() {
        return this.we ? "user" : this.af ? "server(queryID=" + this.Hb + ")" : "server";
      };
      function cf(a) {
        this.X = a;
      }
      var df = new cf(new Me(null));
      function ef(a, b, c) {
        if (b.e())
          return new cf(new Me(c));
        var d = Qe(a.X, b);
        if (null != d) {
          var e = d.path,
              d = d.value;
          b = T(e, b);
          d = d.G(b, c);
          return new cf(a.X.set(e, d));
        }
        a = Od(a.X, b, new Me(c));
        return new cf(a);
      }
      function ff(a, b, c) {
        var d = a;
        ib(c, function(a, c) {
          d = ef(d, b.u(a), c);
        });
        return d;
      }
      cf.prototype.Rd = function(a) {
        if (a.e())
          return df;
        a = Od(this.X, a, Pd);
        return new cf(a);
      };
      function gf(a, b) {
        var c = Qe(a.X, b);
        return null != c ? a.X.get(c.path).Q(T(c.path, b)) : null;
      }
      function hf(a) {
        var b = [],
            c = a.X.value;
        null != c ? c.K() || c.P(N, function(a, c) {
          b.push(new F(a, c));
        }) : a.X.children.ia(function(a, c) {
          null != c.value && b.push(new F(a, c.value));
        });
        return b;
      }
      function jf(a, b) {
        if (b.e())
          return a;
        var c = gf(a, b);
        return null != c ? new cf(new Me(c)) : new cf(a.X.subtree(b));
      }
      cf.prototype.e = function() {
        return this.X.e();
      };
      cf.prototype.apply = function(a) {
        return kf(G, this.X, a);
      };
      function kf(a, b, c) {
        if (null != b.value)
          return c.G(a, b.value);
        var d = null;
        b.children.ia(function(b, f) {
          ".priority" === b ? (K(null !== f.value, "Priority writes must always be leaf nodes"), d = f.value) : c = kf(a.u(b), f, c);
        });
        c.Q(a).e() || null === d || (c = c.G(a.u(".priority"), d));
        return c;
      }
      ;
      function lf() {
        this.T = df;
        this.na = [];
        this.Mc = -1;
      }
      function mf(a, b) {
        for (var c = 0; c < a.na.length; c++) {
          var d = a.na[c];
          if (d.kd === b)
            return d;
        }
        return null;
      }
      g = lf.prototype;
      g.Rd = function(a) {
        var b = Ua(this.na, function(b) {
          return b.kd === a;
        });
        K(0 <= b, "removeWrite called with nonexistent writeId.");
        var c = this.na[b];
        this.na.splice(b, 1);
        for (var d = c.visible,
            e = !1,
            f = this.na.length - 1; d && 0 <= f; ) {
          var h = this.na[f];
          h.visible && (f >= b && nf(h, c.path) ? d = !1 : c.path.contains(h.path) && (e = !0));
          f--;
        }
        if (d) {
          if (e)
            this.T = of(this.na, pf, G), this.Mc = 0 < this.na.length ? this.na[this.na.length - 1].kd : -1;
          else if (c.Ga)
            this.T = this.T.Rd(c.path);
          else {
            var k = this;
            r(c.children, function(a, b) {
              k.T = k.T.Rd(c.path.u(b));
            });
          }
          return !0;
        }
        return !1;
      };
      g.za = function(a, b, c, d) {
        if (c || d) {
          var e = jf(this.T, a);
          return !d && e.e() ? b : d || null != b || null != gf(e, G) ? (e = of(this.na, function(b) {
            return (b.visible || d) && (!c || !(0 <= Na(c, b.kd))) && (b.path.contains(a) || a.contains(b.path));
          }, a), b = b || C, e.apply(b)) : null;
        }
        e = gf(this.T, a);
        if (null != e)
          return e;
        e = jf(this.T, a);
        return e.e() ? b : null != b || null != gf(e, G) ? (b = b || C, e.apply(b)) : null;
      };
      g.yc = function(a, b) {
        var c = C,
            d = gf(this.T, a);
        if (d)
          d.K() || d.P(N, function(a, b) {
            c = c.U(a, b);
          });
        else if (b) {
          var e = jf(this.T, a);
          b.P(N, function(a, b) {
            var d = jf(e, new L(a)).apply(b);
            c = c.U(a, d);
          });
          Oa(hf(e), function(a) {
            c = c.U(a.name, a.S);
          });
        } else
          e = jf(this.T, a), Oa(hf(e), function(a) {
            c = c.U(a.name, a.S);
          });
        return c;
      };
      g.ld = function(a, b, c, d) {
        K(c || d, "Either existingEventSnap or existingServerSnap must exist");
        a = a.u(b);
        if (null != gf(this.T, a))
          return null;
        a = jf(this.T, a);
        return a.e() ? d.Q(b) : a.apply(d.Q(b));
      };
      g.xc = function(a, b, c) {
        a = a.u(b);
        var d = gf(this.T, a);
        return null != d ? d : sb(c, b) ? jf(this.T, a).apply(c.j().R(b)) : null;
      };
      g.tc = function(a) {
        return gf(this.T, a);
      };
      g.ne = function(a, b, c, d, e, f) {
        var h;
        a = jf(this.T, a);
        h = gf(a, G);
        if (null == h)
          if (null != b)
            h = a.apply(b);
          else
            return [];
        h = h.lb(f);
        if (h.e() || h.K())
          return [];
        b = [];
        a = td(f);
        e = e ? h.$b(c, f) : h.Yb(c, f);
        for (f = J(e); f && b.length < d; )
          0 !== a(f, c) && b.push(f), f = J(e);
        return b;
      };
      function nf(a, b) {
        return a.Ga ? a.path.contains(b) : !!ua(a.children, function(c, d) {
          return a.path.u(d).contains(b);
        });
      }
      function pf(a) {
        return a.visible;
      }
      function of(a, b, c) {
        for (var d = df,
            e = 0; e < a.length; ++e) {
          var f = a[e];
          if (b(f)) {
            var h = f.path;
            if (f.Ga)
              c.contains(h) ? (h = T(c, h), d = ef(d, h, f.Ga)) : h.contains(c) && (h = T(h, c), d = ef(d, G, f.Ga.Q(h)));
            else if (f.children)
              if (c.contains(h))
                h = T(c, h), d = ff(d, h, f.children);
              else {
                if (h.contains(c))
                  if (h = T(h, c), h.e())
                    d = ff(d, G, f.children);
                  else if (f = w(f.children, E(h)))
                    f = f.Q(H(h)), d = ef(d, G, f);
              }
            else
              throw Fc("WriteRecord should have .snap or .children");
          }
        }
        return d;
      }
      function qf(a, b) {
        this.Mb = a;
        this.X = b;
      }
      g = qf.prototype;
      g.za = function(a, b, c) {
        return this.X.za(this.Mb, a, b, c);
      };
      g.yc = function(a) {
        return this.X.yc(this.Mb, a);
      };
      g.ld = function(a, b, c) {
        return this.X.ld(this.Mb, a, b, c);
      };
      g.tc = function(a) {
        return this.X.tc(this.Mb.u(a));
      };
      g.ne = function(a, b, c, d, e) {
        return this.X.ne(this.Mb, a, b, c, d, e);
      };
      g.xc = function(a, b) {
        return this.X.xc(this.Mb, a, b);
      };
      g.u = function(a) {
        return new qf(this.Mb.u(a), this.X);
      };
      function rf() {
        this.ya = {};
      }
      g = rf.prototype;
      g.e = function() {
        return wa(this.ya);
      };
      g.ab = function(a, b, c) {
        var d = a.source.Hb;
        if (null !== d)
          return d = w(this.ya, d), K(null != d, "SyncTree gave us an op for an invalid query."), d.ab(a, b, c);
        var e = [];
        r(this.ya, function(d) {
          e = e.concat(d.ab(a, b, c));
        });
        return e;
      };
      g.Pb = function(a, b, c, d, e) {
        var f = a.va(),
            h = w(this.ya, f);
        if (!h) {
          var h = c.za(e ? d : null),
              k = !1;
          h ? k = !0 : (h = d instanceof R ? c.yc(d) : C, k = !1);
          h = new ve(a, new Id(new tb(h, k, !1), new tb(d, e, !1)));
          this.ya[f] = h;
        }
        h.Pb(b);
        return ye(h, b);
      };
      g.jb = function(a, b, c) {
        var d = a.va(),
            e = [],
            f = [],
            h = null != sf(this);
        if ("default" === d) {
          var k = this;
          r(this.ya, function(a, d) {
            f = f.concat(a.jb(b, c));
            a.e() && (delete k.ya[d], S(a.W.n) || e.push(a.W));
          });
        } else {
          var l = w(this.ya, d);
          l && (f = f.concat(l.jb(b, c)), l.e() && (delete this.ya[d], S(l.W.n) || e.push(l.W)));
        }
        h && null == sf(this) && e.push(new U(a.k, a.path));
        return {
          Kg: e,
          mg: f
        };
      };
      function tf(a) {
        return Pa(ra(a.ya), function(a) {
          return !S(a.W.n);
        });
      }
      g.fb = function(a) {
        var b = null;
        r(this.ya, function(c) {
          b = b || c.fb(a);
        });
        return b;
      };
      function uf(a, b) {
        if (S(b.n))
          return sf(a);
        var c = b.va();
        return w(a.ya, c);
      }
      function sf(a) {
        return va(a.ya, function(a) {
          return S(a.W.n);
        }) || null;
      }
      ;
      function vf(a) {
        this.ta = Pd;
        this.ib = new lf;
        this.$e = {};
        this.mc = {};
        this.Nc = a;
      }
      function wf(a, b, c, d, e) {
        var f = a.ib,
            h = e;
        K(d > f.Mc, "Stacking an older write on top of newer ones");
        n(h) || (h = !0);
        f.na.push({
          path: b,
          Ga: c,
          kd: d,
          visible: h
        });
        h && (f.T = ef(f.T, b, c));
        f.Mc = d;
        return e ? xf(a, new Xb($e, b, c)) : [];
      }
      function yf(a, b, c, d) {
        var e = a.ib;
        K(d > e.Mc, "Stacking an older merge on top of newer ones");
        e.na.push({
          path: b,
          children: c,
          kd: d,
          visible: !0
        });
        e.T = ff(e.T, b, c);
        e.Mc = d;
        c = Oe(c);
        return xf(a, new ze($e, b, c));
      }
      function zf(a, b, c) {
        c = c || !1;
        var d = mf(a.ib, b);
        if (a.ib.Rd(b)) {
          var e = Pd;
          null != d.Ga ? e = e.set(G, !0) : ib(d.children, function(a, b) {
            e = e.set(new L(a), b);
          });
          return xf(a, new Ze(d.path, e, c));
        }
        return [];
      }
      function Af(a, b, c) {
        c = Oe(c);
        return xf(a, new ze(bf, b, c));
      }
      function Bf(a, b, c, d) {
        d = Cf(a, d);
        if (null != d) {
          var e = Df(d);
          d = e.path;
          e = e.Hb;
          b = T(d, b);
          c = new Xb(new af(!1, !0, e, !0), b, c);
          return Ef(a, d, c);
        }
        return [];
      }
      function Ff(a, b, c, d) {
        if (d = Cf(a, d)) {
          var e = Df(d);
          d = e.path;
          e = e.Hb;
          b = T(d, b);
          c = Oe(c);
          c = new ze(new af(!1, !0, e, !0), b, c);
          return Ef(a, d, c);
        }
        return [];
      }
      vf.prototype.Pb = function(a, b) {
        var c = a.path,
            d = null,
            e = !1;
        Ve(this.ta, c, function(a, b) {
          var f = T(a, c);
          d = b.fb(f);
          e = e || null != sf(b);
          return !d;
        });
        var f = this.ta.get(c);
        f ? (e = e || null != sf(f), d = d || f.fb(G)) : (f = new rf, this.ta = this.ta.set(c, f));
        var h;
        null != d ? h = !0 : (h = !1, d = C, Ye(this.ta.subtree(c), function(a, b) {
          var c = b.fb(G);
          c && (d = d.U(a, c));
        }));
        var k = null != uf(f, a);
        if (!k && !S(a.n)) {
          var l = Gf(a);
          K(!(l in this.mc), "View does not exist, but we have a tag");
          var m = Hf++;
          this.mc[l] = m;
          this.$e["_" + m] = l;
        }
        h = f.Pb(a, b, new qf(c, this.ib), d, h);
        k || e || (f = uf(f, a), h = h.concat(If(this, a, f)));
        return h;
      };
      vf.prototype.jb = function(a, b, c) {
        var d = a.path,
            e = this.ta.get(d),
            f = [];
        if (e && ("default" === a.va() || null != uf(e, a))) {
          f = e.jb(a, b, c);
          e.e() && (this.ta = this.ta.remove(d));
          e = f.Kg;
          f = f.mg;
          b = -1 !== Ua(e, function(a) {
            return S(a.n);
          });
          var h = Te(this.ta, d, function(a, b) {
            return null != sf(b);
          });
          if (b && !h && (d = this.ta.subtree(d), !d.e()))
            for (var d = Jf(d),
                k = 0; k < d.length; ++k) {
              var l = d[k],
                  m = l.W,
                  l = Kf(this, l);
              this.Nc.Xe(Lf(m), Mf(this, m), l.xd, l.H);
            }
          if (!h && 0 < e.length && !c)
            if (b)
              this.Nc.ae(Lf(a), null);
            else {
              var t = this;
              Oa(e, function(a) {
                a.va();
                var b = t.mc[Gf(a)];
                t.Nc.ae(Lf(a), b);
              });
            }
          Nf(this, e);
        }
        return f;
      };
      vf.prototype.za = function(a, b) {
        var c = this.ib,
            d = Te(this.ta, a, function(b, c) {
              var d = T(b, a);
              if (d = c.fb(d))
                return d;
            });
        return c.za(a, d, b, !0);
      };
      function Jf(a) {
        return Re(a, function(a, c, d) {
          if (c && null != sf(c))
            return [sf(c)];
          var e = [];
          c && (e = tf(c));
          r(d, function(a) {
            e = e.concat(a);
          });
          return e;
        });
      }
      function Nf(a, b) {
        for (var c = 0; c < b.length; ++c) {
          var d = b[c];
          if (!S(d.n)) {
            var d = Gf(d),
                e = a.mc[d];
            delete a.mc[d];
            delete a.$e["_" + e];
          }
        }
      }
      function Lf(a) {
        return S(a.n) && !fe(a.n) ? a.Ib() : a;
      }
      function If(a, b, c) {
        var d = b.path,
            e = Mf(a, b);
        c = Kf(a, c);
        b = a.Nc.Xe(Lf(b), e, c.xd, c.H);
        d = a.ta.subtree(d);
        if (e)
          K(null == sf(d.value), "If we're adding a query, it shouldn't be shadowed");
        else
          for (e = Re(d, function(a, b, c) {
            if (!a.e() && b && null != sf(b))
              return [we(sf(b))];
            var d = [];
            b && (d = d.concat(Qa(tf(b), function(a) {
              return a.W;
            })));
            r(c, function(a) {
              d = d.concat(a);
            });
            return d;
          }), d = 0; d < e.length; ++d)
            c = e[d], a.Nc.ae(Lf(c), Mf(a, c));
        return b;
      }
      function Kf(a, b) {
        var c = b.W,
            d = Mf(a, c);
        return {
          xd: function() {
            return (b.w() || C).hash();
          },
          H: function(b) {
            if ("ok" === b) {
              if (d) {
                var f = c.path;
                if (b = Cf(a, d)) {
                  var h = Df(b);
                  b = h.path;
                  h = h.Hb;
                  f = T(b, f);
                  f = new Zb(new af(!1, !0, h, !0), f);
                  b = Ef(a, b, f);
                } else
                  b = [];
              } else
                b = xf(a, new Zb(bf, c.path));
              return b;
            }
            f = "Unknown Error";
            "too_big" === b ? f = "The data requested exceeds the maximum size that can be accessed with a single request." : "permission_denied" == b ? f = "Client doesn't have permission to access the desired data." : "unavailable" == b && (f = "The service is unavailable");
            f = Error(b + ": " + f);
            f.code = b.toUpperCase();
            return a.jb(c, null, f);
          }
        };
      }
      function Gf(a) {
        return a.path.toString() + "$" + a.va();
      }
      function Df(a) {
        var b = a.indexOf("$");
        K(-1 !== b && b < a.length - 1, "Bad queryKey.");
        return {
          Hb: a.substr(b + 1),
          path: new L(a.substr(0, b))
        };
      }
      function Cf(a, b) {
        var c = a.$e,
            d = "_" + b;
        return d in c ? c[d] : void 0;
      }
      function Mf(a, b) {
        var c = Gf(b);
        return w(a.mc, c);
      }
      var Hf = 1;
      function Ef(a, b, c) {
        var d = a.ta.get(b);
        K(d, "Missing sync point for query tag that we're tracking");
        return d.ab(c, new qf(b, a.ib), null);
      }
      function xf(a, b) {
        return Of(a, b, a.ta, null, new qf(G, a.ib));
      }
      function Of(a, b, c, d, e) {
        if (b.path.e())
          return Pf(a, b, c, d, e);
        var f = c.get(G);
        null == d && null != f && (d = f.fb(G));
        var h = [],
            k = E(b.path),
            l = b.Xc(k);
        if ((c = c.children.get(k)) && l)
          var m = d ? d.R(k) : null,
              k = e.u(k),
              h = h.concat(Of(a, l, c, m, k));
        f && (h = h.concat(f.ab(b, e, d)));
        return h;
      }
      function Pf(a, b, c, d, e) {
        var f = c.get(G);
        null == d && null != f && (d = f.fb(G));
        var h = [];
        c.children.ia(function(c, f) {
          var m = d ? d.R(c) : null,
              t = e.u(c),
              z = b.Xc(c);
          z && (h = h.concat(Pf(a, z, f, m, t)));
        });
        f && (h = h.concat(f.ab(b, e, d)));
        return h;
      }
      ;
      function Qf() {
        this.children = {};
        this.nd = 0;
        this.value = null;
      }
      function Rf(a, b, c) {
        this.Gd = a ? a : "";
        this.Zc = b ? b : null;
        this.A = c ? c : new Qf;
      }
      function Sf(a, b) {
        for (var c = b instanceof L ? b : new L(b),
            d = a,
            e; null !== (e = E(c)); )
          d = new Rf(e, d, w(d.A.children, e) || new Qf), c = H(c);
        return d;
      }
      g = Rf.prototype;
      g.Ca = function() {
        return this.A.value;
      };
      function Tf(a, b) {
        K("undefined" !== typeof b, "Cannot set value to undefined");
        a.A.value = b;
        Uf(a);
      }
      g.clear = function() {
        this.A.value = null;
        this.A.children = {};
        this.A.nd = 0;
        Uf(this);
      };
      g.wd = function() {
        return 0 < this.A.nd;
      };
      g.e = function() {
        return null === this.Ca() && !this.wd();
      };
      g.P = function(a) {
        var b = this;
        r(this.A.children, function(c, d) {
          a(new Rf(d, b, c));
        });
      };
      function Vf(a, b, c, d) {
        c && !d && b(a);
        a.P(function(a) {
          Vf(a, b, !0, d);
        });
        c && d && b(a);
      }
      function Wf(a, b) {
        for (var c = a.parent(); null !== c && !b(c); )
          c = c.parent();
      }
      g.path = function() {
        return new L(null === this.Zc ? this.Gd : this.Zc.path() + "/" + this.Gd);
      };
      g.name = function() {
        return this.Gd;
      };
      g.parent = function() {
        return this.Zc;
      };
      function Uf(a) {
        if (null !== a.Zc) {
          var b = a.Zc,
              c = a.Gd,
              d = a.e(),
              e = v(b.A.children, c);
          d && e ? (delete b.A.children[c], b.A.nd--, Uf(b)) : d || e || (b.A.children[c] = a.A, b.A.nd++, Uf(b));
        }
      }
      ;
      var Xf = /[\[\].#$\/\u0000-\u001F\u007F]/,
          Yf = /[\[\].#$\u0000-\u001F\u007F]/,
          Zf = /^[a-zA-Z][a-zA-Z._\-+]+$/;
      function $f(a) {
        return p(a) && 0 !== a.length && !Xf.test(a);
      }
      function ag(a) {
        return null === a || p(a) || ga(a) && !Qc(a) || ia(a) && v(a, ".sv");
      }
      function bg(a, b, c, d) {
        d && !n(b) || cg(y(a, 1, d), b, c);
      }
      function cg(a, b, c) {
        c instanceof L && (c = new Je(c, a));
        if (!n(b))
          throw Error(a + "contains undefined " + Le(c));
        if (ha(b))
          throw Error(a + "contains a function " + Le(c) + " with contents: " + b.toString());
        if (Qc(b))
          throw Error(a + "contains " + b.toString() + " " + Le(c));
        if (p(b) && b.length > 10485760 / 3 && 10485760 < Zc(b))
          throw Error(a + "contains a string greater than 10485760 utf8 bytes " + Le(c) + " ('" + b.substring(0, 50) + "...')");
        if (ia(b)) {
          var d = !1,
              e = !1;
          ib(b, function(b, h) {
            if (".value" === b)
              d = !0;
            else if (".priority" !== b && ".sv" !== b && (e = !0, !$f(b)))
              throw Error(a + " contains an invalid key (" + b + ") " + Le(c) + '.  Keys must be non-empty strings and can\'t contain ".", "#", "$", "/", "[", or "]"');
            c.push(b);
            cg(a, h, c);
            c.pop();
          });
          if (d && e)
            throw Error(a + ' contains ".value" child ' + Le(c) + " in addition to actual children.");
        }
      }
      function dg(a, b) {
        var c,
            d;
        for (c = 0; c < b.length; c++) {
          d = b[c];
          for (var e = d.slice(),
              f = 0; f < e.length; f++)
            if ((".priority" !== e[f] || f !== e.length - 1) && !$f(e[f]))
              throw Error(a + "contains an invalid key (" + e[f] + ") in path " + d.toString() + '. Keys must be non-empty strings and can\'t contain ".", "#", "$", "/", "[", or "]"');
        }
        b.sort(Ie);
        e = null;
        for (c = 0; c < b.length; c++) {
          d = b[c];
          if (null !== e && e.contains(d))
            throw Error(a + "contains a path " + e.toString() + " that is ancestor of another path " + d.toString());
          e = d;
        }
      }
      function eg(a, b, c) {
        var d = y(a, 1, !1);
        if (!ia(b) || ea(b))
          throw Error(d + " must be an object containing the children to replace.");
        var e = [];
        ib(b, function(a, b) {
          var k = new L(a);
          cg(d, b, c.u(k));
          if (".priority" === Ld(k) && !ag(b))
            throw Error(d + "contains an invalid value for '" + k.toString() + "', which must be a valid Firebase priority (a string, finite number, server value, or null).");
          e.push(k);
        });
        dg(d, e);
      }
      function fg(a, b, c) {
        if (Qc(c))
          throw Error(y(a, b, !1) + "is " + c.toString() + ", but must be a valid Firebase priority (a string, finite number, server value, or null).");
        if (!ag(c))
          throw Error(y(a, b, !1) + "must be a valid Firebase priority (a string, finite number, server value, or null).");
      }
      function gg(a, b, c) {
        if (!c || n(b))
          switch (b) {
            case "value":
            case "child_added":
            case "child_removed":
            case "child_changed":
            case "child_moved":
              break;
            default:
              throw Error(y(a, 1, c) + 'must be a valid event type: "value", "child_added", "child_removed", "child_changed", or "child_moved".');
          }
      }
      function hg(a, b) {
        if (n(b) && !$f(b))
          throw Error(y(a, 2, !0) + 'was an invalid key: "' + b + '".  Firebase keys must be non-empty strings and can\'t contain ".", "#", "$", "/", "[", or "]").');
      }
      function ig(a, b) {
        if (!p(b) || 0 === b.length || Yf.test(b))
          throw Error(y(a, 1, !1) + 'was an invalid path: "' + b + '". Paths must be non-empty strings and can\'t contain ".", "#", "$", "[", or "]"');
      }
      function jg(a, b) {
        if (".info" === E(b))
          throw Error(a + " failed: Can't modify data under /.info/");
      }
      function kg(a, b) {
        if (!p(b))
          throw Error(y(a, 1, !1) + "must be a valid credential (a string).");
      }
      function lg(a, b, c) {
        if (!p(c))
          throw Error(y(a, b, !1) + "must be a valid string.");
      }
      function mg(a, b) {
        lg(a, 1, b);
        if (!Zf.test(b))
          throw Error(y(a, 1, !1) + "'" + b + "' is not a valid authentication provider.");
      }
      function ng(a, b, c, d) {
        if (!d || n(c))
          if (!ia(c) || null === c)
            throw Error(y(a, b, d) + "must be a valid object.");
      }
      function og(a, b, c) {
        if (!ia(b) || !v(b, c))
          throw Error(y(a, 1, !1) + 'must contain the key "' + c + '"');
        if (!p(w(b, c)))
          throw Error(y(a, 1, !1) + 'must contain the key "' + c + '" with type "string"');
      }
      ;
      function pg() {
        this.set = {};
      }
      g = pg.prototype;
      g.add = function(a, b) {
        this.set[a] = null !== b ? b : !0;
      };
      g.contains = function(a) {
        return v(this.set, a);
      };
      g.get = function(a) {
        return this.contains(a) ? this.set[a] : void 0;
      };
      g.remove = function(a) {
        delete this.set[a];
      };
      g.clear = function() {
        this.set = {};
      };
      g.e = function() {
        return wa(this.set);
      };
      g.count = function() {
        return pa(this.set);
      };
      function qg(a, b) {
        r(a.set, function(a, d) {
          b(d, a);
        });
      }
      g.keys = function() {
        var a = [];
        r(this.set, function(b, c) {
          a.push(c);
        });
        return a;
      };
      function qc() {
        this.m = this.B = null;
      }
      qc.prototype.find = function(a) {
        if (null != this.B)
          return this.B.Q(a);
        if (a.e() || null == this.m)
          return null;
        var b = E(a);
        a = H(a);
        return this.m.contains(b) ? this.m.get(b).find(a) : null;
      };
      qc.prototype.nc = function(a, b) {
        if (a.e())
          this.B = b, this.m = null;
        else if (null !== this.B)
          this.B = this.B.G(a, b);
        else {
          null == this.m && (this.m = new pg);
          var c = E(a);
          this.m.contains(c) || this.m.add(c, new qc);
          c = this.m.get(c);
          a = H(a);
          c.nc(a, b);
        }
      };
      function rg(a, b) {
        if (b.e())
          return a.B = null, a.m = null, !0;
        if (null !== a.B) {
          if (a.B.K())
            return !1;
          var c = a.B;
          a.B = null;
          c.P(N, function(b, c) {
            a.nc(new L(b), c);
          });
          return rg(a, b);
        }
        return null !== a.m ? (c = E(b), b = H(b), a.m.contains(c) && rg(a.m.get(c), b) && a.m.remove(c), a.m.e() ? (a.m = null, !0) : !1) : !0;
      }
      function rc(a, b, c) {
        null !== a.B ? c(b, a.B) : a.P(function(a, e) {
          var f = new L(b.toString() + "/" + a);
          rc(e, f, c);
        });
      }
      qc.prototype.P = function(a) {
        null !== this.m && qg(this.m, function(b, c) {
          a(b, c);
        });
      };
      var sg = "auth.firebase.com";
      function tg(a, b, c) {
        this.od = a || {};
        this.ee = b || {};
        this.$a = c || {};
        this.od.remember || (this.od.remember = "default");
      }
      var ug = ["remember", "redirectTo"];
      function vg(a) {
        var b = {},
            c = {};
        ib(a || {}, function(a, e) {
          0 <= Na(ug, a) ? b[a] = e : c[a] = e;
        });
        return new tg(b, {}, c);
      }
      ;
      function wg(a, b) {
        this.Qe = ["session", a.Od, a.hc].join(":");
        this.be = b;
      }
      wg.prototype.set = function(a, b) {
        if (!b)
          if (this.be.length)
            b = this.be[0];
          else
            throw Error("fb.login.SessionManager : No storage options available!");
        b.set(this.Qe, a);
      };
      wg.prototype.get = function() {
        var a = Qa(this.be, q(this.qg, this)),
            a = Pa(a, function(a) {
              return null !== a;
            });
        Xa(a, function(a, c) {
          return ad(c.token) - ad(a.token);
        });
        return 0 < a.length ? a.shift() : null;
      };
      wg.prototype.qg = function(a) {
        try {
          var b = a.get(this.Qe);
          if (b && b.token)
            return b;
        } catch (c) {}
        return null;
      };
      wg.prototype.clear = function() {
        var a = this;
        Oa(this.be, function(b) {
          b.remove(a.Qe);
        });
      };
      function xg() {
        return "undefined" !== typeof navigator && "string" === typeof navigator.userAgent ? navigator.userAgent : "";
      }
      function yg() {
        return "undefined" !== typeof window && !!(window.cordova || window.phonegap || window.PhoneGap) && /ios|iphone|ipod|ipad|android|blackberry|iemobile/i.test(xg());
      }
      function zg() {
        return "undefined" !== typeof location && /^file:\//.test(location.href);
      }
      function Ag(a) {
        var b = xg();
        if ("" === b)
          return !1;
        if ("Microsoft Internet Explorer" === navigator.appName) {
          if ((b = b.match(/MSIE ([0-9]{1,}[\.0-9]{0,})/)) && 1 < b.length)
            return parseFloat(b[1]) >= a;
        } else if (-1 < b.indexOf("Trident") && (b = b.match(/rv:([0-9]{2,2}[\.0-9]{0,})/)) && 1 < b.length)
          return parseFloat(b[1]) >= a;
        return !1;
      }
      ;
      function Bg() {
        var a = window.opener.frames,
            b;
        for (b = a.length - 1; 0 <= b; b--)
          try {
            if (a[b].location.protocol === window.location.protocol && a[b].location.host === window.location.host && "__winchan_relay_frame" === a[b].name)
              return a[b];
          } catch (c) {}
        return null;
      }
      function Cg(a, b, c) {
        a.attachEvent ? a.attachEvent("on" + b, c) : a.addEventListener && a.addEventListener(b, c, !1);
      }
      function Dg(a, b, c) {
        a.detachEvent ? a.detachEvent("on" + b, c) : a.removeEventListener && a.removeEventListener(b, c, !1);
      }
      function Eg(a) {
        /^https?:\/\//.test(a) || (a = window.location.href);
        var b = /^(https?:\/\/[\-_a-zA-Z\.0-9:]+)/.exec(a);
        return b ? b[1] : a;
      }
      function Fg(a) {
        var b = "";
        try {
          a = a.replace("#", "");
          var c = lb(a);
          c && v(c, "__firebase_request_key") && (b = w(c, "__firebase_request_key"));
        } catch (d) {}
        return b;
      }
      function Gg() {
        var a = Pc(sg);
        return a.scheme + "://" + a.host + "/v2";
      }
      function Hg(a) {
        return Gg() + "/" + a + "/auth/channel";
      }
      ;
      function Ig(a) {
        var b = this;
        this.Ac = a;
        this.ce = "*";
        Ag(8) ? this.Rc = this.zd = Bg() : (this.Rc = window.opener, this.zd = window);
        if (!b.Rc)
          throw "Unable to find relay frame";
        Cg(this.zd, "message", q(this.jc, this));
        Cg(this.zd, "message", q(this.Bf, this));
        try {
          Jg(this, {a: "ready"});
        } catch (c) {
          Cg(this.Rc, "load", function() {
            Jg(b, {a: "ready"});
          });
        }
        Cg(window, "unload", q(this.Bg, this));
      }
      function Jg(a, b) {
        b = B(b);
        Ag(8) ? a.Rc.doPost(b, a.ce) : a.Rc.postMessage(b, a.ce);
      }
      Ig.prototype.jc = function(a) {
        var b = this,
            c;
        try {
          c = nb(a.data);
        } catch (d) {}
        c && "request" === c.a && (Dg(window, "message", this.jc), this.ce = a.origin, this.Ac && setTimeout(function() {
          b.Ac(b.ce, c.d, function(a, c) {
            b.dg = !c;
            b.Ac = void 0;
            Jg(b, {
              a: "response",
              d: a,
              forceKeepWindowOpen: c
            });
          });
        }, 0));
      };
      Ig.prototype.Bg = function() {
        try {
          Dg(this.zd, "message", this.Bf);
        } catch (a) {}
        this.Ac && (Jg(this, {
          a: "error",
          d: "unknown closed window"
        }), this.Ac = void 0);
        try {
          window.close();
        } catch (b) {}
      };
      Ig.prototype.Bf = function(a) {
        if (this.dg && "die" === a.data)
          try {
            window.close();
          } catch (b) {}
      };
      function Kg(a) {
        this.pc = Ga() + Ga() + Ga();
        this.Ef = a;
      }
      Kg.prototype.open = function(a, b) {
        yc.set("redirect_request_id", this.pc);
        yc.set("redirect_request_id", this.pc);
        b.requestId = this.pc;
        b.redirectTo = b.redirectTo || window.location.href;
        a += (/\?/.test(a) ? "" : "?") + kb(b);
        window.location = a;
      };
      Kg.isAvailable = function() {
        return !zg() && !yg();
      };
      Kg.prototype.Cc = function() {
        return "redirect";
      };
      var Lg = {
        NETWORK_ERROR: "Unable to contact the Firebase server.",
        SERVER_ERROR: "An unknown server error occurred.",
        TRANSPORT_UNAVAILABLE: "There are no login transports available for the requested method.",
        REQUEST_INTERRUPTED: "The browser redirected the page before the login request could complete.",
        USER_CANCELLED: "The user cancelled authentication."
      };
      function Mg(a) {
        var b = Error(w(Lg, a), a);
        b.code = a;
        return b;
      }
      ;
      function Ng(a) {
        var b;
        (b = !a.window_features) || (b = xg(), b = -1 !== b.indexOf("Fennec/") || -1 !== b.indexOf("Firefox/") && -1 !== b.indexOf("Android"));
        b && (a.window_features = void 0);
        a.window_name || (a.window_name = "_blank");
        this.options = a;
      }
      Ng.prototype.open = function(a, b, c) {
        function d(a) {
          h && (document.body.removeChild(h), h = void 0);
          t && (t = clearInterval(t));
          Dg(window, "message", e);
          Dg(window, "unload", d);
          if (m && !a)
            try {
              m.close();
            } catch (b) {
              k.postMessage("die", l);
            }
          m = k = void 0;
        }
        function e(a) {
          if (a.origin === l)
            try {
              var b = nb(a.data);
              "ready" === b.a ? k.postMessage(z, l) : "error" === b.a ? (d(!1), c && (c(b.d), c = null)) : "response" === b.a && (d(b.forceKeepWindowOpen), c && (c(null, b.d), c = null));
            } catch (e) {}
        }
        var f = Ag(8),
            h,
            k;
        if (!this.options.relay_url)
          return c(Error("invalid arguments: origin of url and relay_url must match"));
        var l = Eg(a);
        if (l !== Eg(this.options.relay_url))
          c && setTimeout(function() {
            c(Error("invalid arguments: origin of url and relay_url must match"));
          }, 0);
        else {
          f && (h = document.createElement("iframe"), h.setAttribute("src", this.options.relay_url), h.style.display = "none", h.setAttribute("name", "__winchan_relay_frame"), document.body.appendChild(h), k = h.contentWindow);
          a += (/\?/.test(a) ? "" : "?") + kb(b);
          var m = window.open(a, this.options.window_name, this.options.window_features);
          k || (k = m);
          var t = setInterval(function() {
            m && m.closed && (d(!1), c && (c(Mg("USER_CANCELLED")), c = null));
          }, 500),
              z = B({
                a: "request",
                d: b
              });
          Cg(window, "unload", d);
          Cg(window, "message", e);
        }
      };
      Ng.isAvailable = function() {
        var a;
        if (a = "postMessage" in window && !zg())
          (a = yg() || "undefined" !== typeof navigator && (!!xg().match(/Windows Phone/) || !!window.Windows && /^ms-appx:/.test(location.href))) || (a = xg(), a = "undefined" !== typeof navigator && "undefined" !== typeof window && !!(a.match(/(iPhone|iPod|iPad).*AppleWebKit(?!.*Safari)/i) || a.match(/CriOS/) || a.match(/Twitter for iPhone/) || a.match(/FBAN\/FBIOS/) || window.navigator.standalone)), a = !a;
        return a && !xg().match(/PhantomJS/);
      };
      Ng.prototype.Cc = function() {
        return "popup";
      };
      function Og(a) {
        a.method || (a.method = "GET");
        a.headers || (a.headers = {});
        a.headers.content_type || (a.headers.content_type = "application/json");
        a.headers.content_type = a.headers.content_type.toLowerCase();
        this.options = a;
      }
      Og.prototype.open = function(a, b, c) {
        function d() {
          c && (c(Mg("REQUEST_INTERRUPTED")), c = null);
        }
        var e = new XMLHttpRequest,
            f = this.options.method.toUpperCase(),
            h;
        Cg(window, "beforeunload", d);
        e.onreadystatechange = function() {
          if (c && 4 === e.readyState) {
            var a;
            if (200 <= e.status && 300 > e.status) {
              try {
                a = nb(e.responseText);
              } catch (b) {}
              c(null, a);
            } else
              500 <= e.status && 600 > e.status ? c(Mg("SERVER_ERROR")) : c(Mg("NETWORK_ERROR"));
            c = null;
            Dg(window, "beforeunload", d);
          }
        };
        if ("GET" === f)
          a += (/\?/.test(a) ? "" : "?") + kb(b), h = null;
        else {
          var k = this.options.headers.content_type;
          "application/json" === k && (h = B(b));
          "application/x-www-form-urlencoded" === k && (h = kb(b));
        }
        e.open(f, a, !0);
        a = {
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json;text/plain"
        };
        za(a, this.options.headers);
        for (var l in a)
          e.setRequestHeader(l, a[l]);
        e.send(h);
      };
      Og.isAvailable = function() {
        var a;
        if (a = !!window.XMLHttpRequest)
          a = xg(), a = !(a.match(/MSIE/) || a.match(/Trident/)) || Ag(10);
        return a;
      };
      Og.prototype.Cc = function() {
        return "json";
      };
      function Pg(a) {
        this.pc = Ga() + Ga() + Ga();
        this.Ef = a;
      }
      Pg.prototype.open = function(a, b, c) {
        function d() {
          c && (c(Mg("USER_CANCELLED")), c = null);
        }
        var e = this,
            f = Pc(sg),
            h;
        b.requestId = this.pc;
        b.redirectTo = f.scheme + "://" + f.host + "/blank/page.html";
        a += /\?/.test(a) ? "" : "?";
        a += kb(b);
        (h = window.open(a, "_blank", "location=no")) && ha(h.addEventListener) ? (h.addEventListener("loadstart", function(a) {
          var b;
          if (b = a && a.url)
            a: {
              try {
                var m = document.createElement("a");
                m.href = a.url;
                b = m.host === f.host && "/blank/page.html" === m.pathname;
                break a;
              } catch (t) {}
              b = !1;
            }
          b && (a = Fg(a.url), h.removeEventListener("exit", d), h.close(), a = new tg(null, null, {
            requestId: e.pc,
            requestKey: a
          }), e.Ef.requestWithCredential("/auth/session", a, c), c = null);
        }), h.addEventListener("exit", d)) : c(Mg("TRANSPORT_UNAVAILABLE"));
      };
      Pg.isAvailable = function() {
        return yg();
      };
      Pg.prototype.Cc = function() {
        return "redirect";
      };
      function Qg(a) {
        a.callback_parameter || (a.callback_parameter = "callback");
        this.options = a;
        window.__firebase_auth_jsonp = window.__firebase_auth_jsonp || {};
      }
      Qg.prototype.open = function(a, b, c) {
        function d() {
          c && (c(Mg("REQUEST_INTERRUPTED")), c = null);
        }
        function e() {
          setTimeout(function() {
            window.__firebase_auth_jsonp[f] = void 0;
            wa(window.__firebase_auth_jsonp) && (window.__firebase_auth_jsonp = void 0);
            try {
              var a = document.getElementById(f);
              a && a.parentNode.removeChild(a);
            } catch (b) {}
          }, 1);
          Dg(window, "beforeunload", d);
        }
        var f = "fn" + (new Date).getTime() + Math.floor(99999 * Math.random());
        b[this.options.callback_parameter] = "__firebase_auth_jsonp." + f;
        a += (/\?/.test(a) ? "" : "?") + kb(b);
        Cg(window, "beforeunload", d);
        window.__firebase_auth_jsonp[f] = function(a) {
          c && (c(null, a), c = null);
          e();
        };
        Rg(f, a, c);
      };
      function Rg(a, b, c) {
        setTimeout(function() {
          try {
            var d = document.createElement("script");
            d.type = "text/javascript";
            d.id = a;
            d.async = !0;
            d.src = b;
            d.onerror = function() {
              var b = document.getElementById(a);
              null !== b && b.parentNode.removeChild(b);
              c && c(Mg("NETWORK_ERROR"));
            };
            var e = document.getElementsByTagName("head");
            (e && 0 != e.length ? e[0] : document.documentElement).appendChild(d);
          } catch (f) {
            c && c(Mg("NETWORK_ERROR"));
          }
        }, 0);
      }
      Qg.isAvailable = function() {
        return "undefined" !== typeof document && null != document.createElement;
      };
      Qg.prototype.Cc = function() {
        return "json";
      };
      function Sg(a, b, c, d) {
        De.call(this, ["auth_status"]);
        this.F = a;
        this.df = b;
        this.Vg = c;
        this.Le = d;
        this.sc = new wg(a, [xc, yc]);
        this.mb = null;
        this.Se = !1;
        Tg(this);
      }
      ma(Sg, De);
      g = Sg.prototype;
      g.xe = function() {
        return this.mb || null;
      };
      function Tg(a) {
        yc.get("redirect_request_id") && Ug(a);
        var b = a.sc.get();
        b && b.token ? (Vg(a, b), a.df(b.token, function(c, d) {
          Wg(a, c, d, !1, b.token, b);
        }, function(b, d) {
          Xg(a, "resumeSession()", b, d);
        })) : Vg(a, null);
      }
      function Yg(a, b, c, d, e, f) {
        "firebaseio-demo.com" === a.F.domain && O("Firebase authentication is not supported on demo Firebases (*.firebaseio-demo.com). To secure your Firebase, create a production Firebase at https://www.firebase.com.");
        a.df(b, function(f, k) {
          Wg(a, f, k, !0, b, c, d || {}, e);
        }, function(b, c) {
          Xg(a, "auth()", b, c, f);
        });
      }
      function Zg(a, b) {
        a.sc.clear();
        Vg(a, null);
        a.Vg(function(a, d) {
          if ("ok" === a)
            P(b, null);
          else {
            var e = (a || "error").toUpperCase(),
                f = e;
            d && (f += ": " + d);
            f = Error(f);
            f.code = e;
            P(b, f);
          }
        });
      }
      function Wg(a, b, c, d, e, f, h, k) {
        "ok" === b ? (d && (b = c.auth, f.auth = b, f.expires = c.expires, f.token = bd(e) ? e : "", c = null, b && v(b, "uid") ? c = w(b, "uid") : v(f, "uid") && (c = w(f, "uid")), f.uid = c, c = "custom", b && v(b, "provider") ? c = w(b, "provider") : v(f, "provider") && (c = w(f, "provider")), f.provider = c, a.sc.clear(), bd(e) && (h = h || {}, c = xc, "sessionOnly" === h.remember && (c = yc), "none" !== h.remember && a.sc.set(f, c)), Vg(a, f)), P(k, null, f)) : (a.sc.clear(), Vg(a, null), f = a = (b || "error").toUpperCase(), c && (f += ": " + c), f = Error(f), f.code = a, P(k, f));
      }
      function Xg(a, b, c, d, e) {
        O(b + " was canceled: " + d);
        a.sc.clear();
        Vg(a, null);
        a = Error(d);
        a.code = c.toUpperCase();
        P(e, a);
      }
      function $g(a, b, c, d, e) {
        ah(a);
        c = new tg(d || {}, {}, c || {});
        bh(a, [Og, Qg], "/auth/" + b, c, e);
      }
      function ch(a, b, c, d) {
        ah(a);
        var e = [Ng, Pg];
        c = vg(c);
        "anonymous" === b || "password" === b ? setTimeout(function() {
          P(d, Mg("TRANSPORT_UNAVAILABLE"));
        }, 0) : (c.ee.window_features = "menubar=yes,modal=yes,alwaysRaised=yeslocation=yes,resizable=yes,scrollbars=yes,status=yes,height=625,width=625,top=" + ("object" === typeof screen ? .5 * (screen.height - 625) : 0) + ",left=" + ("object" === typeof screen ? .5 * (screen.width - 625) : 0), c.ee.relay_url = Hg(a.F.hc), c.ee.requestWithCredential = q(a.qc, a), bh(a, e, "/auth/" + b, c, d));
      }
      function Ug(a) {
        var b = yc.get("redirect_request_id");
        if (b) {
          var c = yc.get("redirect_client_options");
          yc.remove("redirect_request_id");
          yc.remove("redirect_client_options");
          var d = [Og, Qg],
              b = {
                requestId: b,
                requestKey: Fg(document.location.hash)
              },
              c = new tg(c, {}, b);
          a.Se = !0;
          try {
            document.location.hash = document.location.hash.replace(/&__firebase_request_key=([a-zA-z0-9]*)/, "");
          } catch (e) {}
          bh(a, d, "/auth/session", c, function() {
            this.Se = !1;
          }.bind(a));
        }
      }
      g.se = function(a, b) {
        ah(this);
        var c = vg(a);
        c.$a._method = "POST";
        this.qc("/users", c, function(a, c) {
          a ? P(b, a) : P(b, a, c);
        });
      };
      g.Te = function(a, b) {
        var c = this;
        ah(this);
        var d = "/users/" + encodeURIComponent(a.email),
            e = vg(a);
        e.$a._method = "DELETE";
        this.qc(d, e, function(a, d) {
          !a && d && d.uid && c.mb && c.mb.uid && c.mb.uid === d.uid && Zg(c);
          P(b, a);
        });
      };
      g.pe = function(a, b) {
        ah(this);
        var c = "/users/" + encodeURIComponent(a.email) + "/password",
            d = vg(a);
        d.$a._method = "PUT";
        d.$a.password = a.newPassword;
        this.qc(c, d, function(a) {
          P(b, a);
        });
      };
      g.oe = function(a, b) {
        ah(this);
        var c = "/users/" + encodeURIComponent(a.oldEmail) + "/email",
            d = vg(a);
        d.$a._method = "PUT";
        d.$a.email = a.newEmail;
        d.$a.password = a.password;
        this.qc(c, d, function(a) {
          P(b, a);
        });
      };
      g.Ve = function(a, b) {
        ah(this);
        var c = "/users/" + encodeURIComponent(a.email) + "/password",
            d = vg(a);
        d.$a._method = "POST";
        this.qc(c, d, function(a) {
          P(b, a);
        });
      };
      g.qc = function(a, b, c) {
        dh(this, [Og, Qg], a, b, c);
      };
      function bh(a, b, c, d, e) {
        dh(a, b, c, d, function(b, c) {
          !b && c && c.token && c.uid ? Yg(a, c.token, c, d.od, function(a, b) {
            a ? P(e, a) : P(e, null, b);
          }) : P(e, b || Mg("UNKNOWN_ERROR"));
        });
      }
      function dh(a, b, c, d, e) {
        b = Pa(b, function(a) {
          return "function" === typeof a.isAvailable && a.isAvailable();
        });
        0 === b.length ? setTimeout(function() {
          P(e, Mg("TRANSPORT_UNAVAILABLE"));
        }, 0) : (b = new (b.shift())(d.ee), d = jb(d.$a), d.v = "js-" + hb, d.transport = b.Cc(), d.suppress_status_codes = !0, a = Gg() + "/" + a.F.hc + c, b.open(a, d, function(a, b) {
          if (a)
            P(e, a);
          else if (b && b.error) {
            var c = Error(b.error.message);
            c.code = b.error.code;
            c.details = b.error.details;
            P(e, c);
          } else
            P(e, null, b);
        }));
      }
      function Vg(a, b) {
        var c = null !== a.mb || null !== b;
        a.mb = b;
        c && a.fe("auth_status", b);
        a.Le(null !== b);
      }
      g.Ae = function(a) {
        K("auth_status" === a, 'initial event must be of type "auth_status"');
        return this.Se ? null : [this.mb];
      };
      function ah(a) {
        var b = a.F;
        if ("firebaseio.com" !== b.domain && "firebaseio-demo.com" !== b.domain && "auth.firebase.com" === sg)
          throw Error("This custom Firebase server ('" + a.F.domain + "') does not support delegated login.");
      }
      ;
      var Cc = "websocket",
          Dc = "long_polling";
      function eh(a) {
        this.jc = a;
        this.Nd = [];
        this.Sb = 0;
        this.qe = -1;
        this.Fb = null;
      }
      function fh(a, b, c) {
        a.qe = b;
        a.Fb = c;
        a.qe < a.Sb && (a.Fb(), a.Fb = null);
      }
      function gh(a, b, c) {
        for (a.Nd[b] = c; a.Nd[a.Sb]; ) {
          var d = a.Nd[a.Sb];
          delete a.Nd[a.Sb];
          for (var e = 0; e < d.length; ++e)
            if (d[e]) {
              var f = a;
              Db(function() {
                f.jc(d[e]);
              });
            }
          if (a.Sb === a.qe) {
            a.Fb && (clearTimeout(a.Fb), a.Fb(), a.Fb = null);
            break;
          }
          a.Sb++;
        }
      }
      ;
      function hh(a, b, c, d) {
        this.re = a;
        this.f = Mc(a);
        this.nb = this.ob = 0;
        this.Ua = Rb(b);
        this.Qf = c;
        this.Hc = !1;
        this.Bb = d;
        this.jd = function(a) {
          return Bc(b, Dc, a);
        };
      }
      var ih,
          jh;
      hh.prototype.open = function(a, b) {
        this.hf = 0;
        this.la = b;
        this.Af = new eh(a);
        this.zb = !1;
        var c = this;
        this.qb = setTimeout(function() {
          c.f("Timed out trying to connect.");
          c.gb();
          c.qb = null;
        }, Math.floor(3E4));
        Rc(function() {
          if (!c.zb) {
            c.Sa = new kh(function(a, b, d, k, l) {
              lh(c, arguments);
              if (c.Sa)
                if (c.qb && (clearTimeout(c.qb), c.qb = null), c.Hc = !0, "start" == a)
                  c.id = b, c.Gf = d;
                else if ("close" === a)
                  b ? (c.Sa.Xd = !1, fh(c.Af, b, function() {
                    c.gb();
                  })) : c.gb();
                else
                  throw Error("Unrecognized command received: " + a);
            }, function(a, b) {
              lh(c, arguments);
              gh(c.Af, a, b);
            }, function() {
              c.gb();
            }, c.jd);
            var a = {start: "t"};
            a.ser = Math.floor(1E8 * Math.random());
            c.Sa.he && (a.cb = c.Sa.he);
            a.v = "5";
            c.Qf && (a.s = c.Qf);
            c.Bb && (a.ls = c.Bb);
            "undefined" !== typeof location && location.href && -1 !== location.href.indexOf("firebaseio.com") && (a.r = "f");
            a = c.jd(a);
            c.f("Connecting via long-poll to " + a);
            mh(c.Sa, a, function() {});
          }
        });
      };
      hh.prototype.start = function() {
        var a = this.Sa,
            b = this.Gf;
        a.ug = this.id;
        a.vg = b;
        for (a.le = !0; nh(a); )
          ;
        a = this.id;
        b = this.Gf;
        this.gc = document.createElement("iframe");
        var c = {dframe: "t"};
        c.id = a;
        c.pw = b;
        this.gc.src = this.jd(c);
        this.gc.style.display = "none";
        document.body.appendChild(this.gc);
      };
      hh.isAvailable = function() {
        return ih || !jh && "undefined" !== typeof document && null != document.createElement && !("object" === typeof window && window.chrome && window.chrome.extension && !/^chrome/.test(window.location.href)) && !("object" === typeof Windows && "object" === typeof Windows.Xg) && !0;
      };
      g = hh.prototype;
      g.Ed = function() {};
      g.dd = function() {
        this.zb = !0;
        this.Sa && (this.Sa.close(), this.Sa = null);
        this.gc && (document.body.removeChild(this.gc), this.gc = null);
        this.qb && (clearTimeout(this.qb), this.qb = null);
      };
      g.gb = function() {
        this.zb || (this.f("Longpoll is closing itself"), this.dd(), this.la && (this.la(this.Hc), this.la = null));
      };
      g.close = function() {
        this.zb || (this.f("Longpoll is being closed."), this.dd());
      };
      g.send = function(a) {
        a = B(a);
        this.ob += a.length;
        Ob(this.Ua, "bytes_sent", a.length);
        a = Ic(a);
        a = fb(a, !0);
        a = Vc(a, 1840);
        for (var b = 0; b < a.length; b++) {
          var c = this.Sa;
          c.ad.push({
            Mg: this.hf,
            Ug: a.length,
            kf: a[b]
          });
          c.le && nh(c);
          this.hf++;
        }
      };
      function lh(a, b) {
        var c = B(b).length;
        a.nb += c;
        Ob(a.Ua, "bytes_received", c);
      }
      function kh(a, b, c, d) {
        this.jd = d;
        this.hb = c;
        this.Pe = new pg;
        this.ad = [];
        this.te = Math.floor(1E8 * Math.random());
        this.Xd = !0;
        this.he = Ec();
        window["pLPCommand" + this.he] = a;
        window["pRTLPCB" + this.he] = b;
        a = document.createElement("iframe");
        a.style.display = "none";
        if (document.body) {
          document.body.appendChild(a);
          try {
            a.contentWindow.document || Cb("No IE domain setting required");
          } catch (e) {
            a.src = "javascript:void((function(){document.open();document.domain='" + document.domain + "';document.close();})())";
          }
        } else
          throw "Document body has not initialized. Wait to initialize Firebase until after the document is ready.";
        a.contentDocument ? a.eb = a.contentDocument : a.contentWindow ? a.eb = a.contentWindow.document : a.document && (a.eb = a.document);
        this.Ea = a;
        a = "";
        this.Ea.src && "javascript:" === this.Ea.src.substr(0, 11) && (a = '<script>document.domain="' + document.domain + '";\x3c/script>');
        a = "<html><body>" + a + "</body></html>";
        try {
          this.Ea.eb.open(), this.Ea.eb.write(a), this.Ea.eb.close();
        } catch (f) {
          Cb("frame writing exception"), f.stack && Cb(f.stack), Cb(f);
        }
      }
      kh.prototype.close = function() {
        this.le = !1;
        if (this.Ea) {
          this.Ea.eb.body.innerHTML = "";
          var a = this;
          setTimeout(function() {
            null !== a.Ea && (document.body.removeChild(a.Ea), a.Ea = null);
          }, Math.floor(0));
        }
        var b = this.hb;
        b && (this.hb = null, b());
      };
      function nh(a) {
        if (a.le && a.Xd && a.Pe.count() < (0 < a.ad.length ? 2 : 1)) {
          a.te++;
          var b = {};
          b.id = a.ug;
          b.pw = a.vg;
          b.ser = a.te;
          for (var b = a.jd(b),
              c = "",
              d = 0; 0 < a.ad.length; )
            if (1870 >= a.ad[0].kf.length + 30 + c.length) {
              var e = a.ad.shift(),
                  c = c + "&seg" + d + "=" + e.Mg + "&ts" + d + "=" + e.Ug + "&d" + d + "=" + e.kf;
              d++;
            } else
              break;
          oh(a, b + c, a.te);
          return !0;
        }
        return !1;
      }
      function oh(a, b, c) {
        function d() {
          a.Pe.remove(c);
          nh(a);
        }
        a.Pe.add(c, 1);
        var e = setTimeout(d, Math.floor(25E3));
        mh(a, b, function() {
          clearTimeout(e);
          d();
        });
      }
      function mh(a, b, c) {
        setTimeout(function() {
          try {
            if (a.Xd) {
              var d = a.Ea.eb.createElement("script");
              d.type = "text/javascript";
              d.async = !0;
              d.src = b;
              d.onload = d.onreadystatechange = function() {
                var a = d.readyState;
                a && "loaded" !== a && "complete" !== a || (d.onload = d.onreadystatechange = null, d.parentNode && d.parentNode.removeChild(d), c());
              };
              d.onerror = function() {
                Cb("Long-poll script failed to load: " + b);
                a.Xd = !1;
                a.close();
              };
              a.Ea.eb.body.appendChild(d);
            }
          } catch (e) {}
        }, Math.floor(1));
      }
      ;
      var ph = null;
      "undefined" !== typeof MozWebSocket ? ph = MozWebSocket : "undefined" !== typeof WebSocket && (ph = WebSocket);
      function qh(a, b, c, d) {
        this.re = a;
        this.f = Mc(this.re);
        this.frames = this.Kc = null;
        this.nb = this.ob = this.bf = 0;
        this.Ua = Rb(b);
        a = {v: "5"};
        "undefined" !== typeof location && location.href && -1 !== location.href.indexOf("firebaseio.com") && (a.r = "f");
        c && (a.s = c);
        d && (a.ls = d);
        this.ef = Bc(b, Cc, a);
      }
      var rh;
      qh.prototype.open = function(a, b) {
        this.hb = b;
        this.zg = a;
        this.f("Websocket connecting to " + this.ef);
        this.Hc = !1;
        xc.set("previous_websocket_failure", !0);
        try {
          this.ua = new ph(this.ef);
        } catch (c) {
          this.f("Error instantiating WebSocket.");
          var d = c.message || c.data;
          d && this.f(d);
          this.gb();
          return;
        }
        var e = this;
        this.ua.onopen = function() {
          e.f("Websocket connected.");
          e.Hc = !0;
        };
        this.ua.onclose = function() {
          e.f("Websocket connection was disconnected.");
          e.ua = null;
          e.gb();
        };
        this.ua.onmessage = function(a) {
          if (null !== e.ua)
            if (a = a.data, e.nb += a.length, Ob(e.Ua, "bytes_received", a.length), sh(e), null !== e.frames)
              th(e, a);
            else {
              a: {
                K(null === e.frames, "We already have a frame buffer");
                if (6 >= a.length) {
                  var b = Number(a);
                  if (!isNaN(b)) {
                    e.bf = b;
                    e.frames = [];
                    a = null;
                    break a;
                  }
                }
                e.bf = 1;
                e.frames = [];
              }
              null !== a && th(e, a);
            }
        };
        this.ua.onerror = function(a) {
          e.f("WebSocket error.  Closing connection.");
          (a = a.message || a.data) && e.f(a);
          e.gb();
        };
      };
      qh.prototype.start = function() {};
      qh.isAvailable = function() {
        var a = !1;
        if ("undefined" !== typeof navigator && navigator.userAgent) {
          var b = navigator.userAgent.match(/Android ([0-9]{0,}\.[0-9]{0,})/);
          b && 1 < b.length && 4.4 > parseFloat(b[1]) && (a = !0);
        }
        return !a && null !== ph && !rh;
      };
      qh.responsesRequiredToBeHealthy = 2;
      qh.healthyTimeout = 3E4;
      g = qh.prototype;
      g.Ed = function() {
        xc.remove("previous_websocket_failure");
      };
      function th(a, b) {
        a.frames.push(b);
        if (a.frames.length == a.bf) {
          var c = a.frames.join("");
          a.frames = null;
          c = nb(c);
          a.zg(c);
        }
      }
      g.send = function(a) {
        sh(this);
        a = B(a);
        this.ob += a.length;
        Ob(this.Ua, "bytes_sent", a.length);
        a = Vc(a, 16384);
        1 < a.length && this.ua.send(String(a.length));
        for (var b = 0; b < a.length; b++)
          this.ua.send(a[b]);
      };
      g.dd = function() {
        this.zb = !0;
        this.Kc && (clearInterval(this.Kc), this.Kc = null);
        this.ua && (this.ua.close(), this.ua = null);
      };
      g.gb = function() {
        this.zb || (this.f("WebSocket is closing itself"), this.dd(), this.hb && (this.hb(this.Hc), this.hb = null));
      };
      g.close = function() {
        this.zb || (this.f("WebSocket is being closed"), this.dd());
      };
      function sh(a) {
        clearInterval(a.Kc);
        a.Kc = setInterval(function() {
          a.ua && a.ua.send("0");
          sh(a);
        }, Math.floor(45E3));
      }
      ;
      function uh(a) {
        vh(this, a);
      }
      var wh = [hh, qh];
      function vh(a, b) {
        var c = qh && qh.isAvailable(),
            d = c && !(xc.wf || !0 === xc.get("previous_websocket_failure"));
        b.Wg && (c || O("wss:// URL used, but browser isn't known to support websockets.  Trying anyway."), d = !0);
        if (d)
          a.gd = [qh];
        else {
          var e = a.gd = [];
          Wc(wh, function(a, b) {
            b && b.isAvailable() && e.push(b);
          });
        }
      }
      function xh(a) {
        if (0 < a.gd.length)
          return a.gd[0];
        throw Error("No transports available");
      }
      ;
      function yh(a, b, c, d, e, f, h) {
        this.id = a;
        this.f = Mc("c:" + this.id + ":");
        this.jc = c;
        this.Wc = d;
        this.la = e;
        this.Ne = f;
        this.F = b;
        this.Md = [];
        this.ff = 0;
        this.Pf = new uh(b);
        this.Ta = 0;
        this.Bb = h;
        this.f("Connection created");
        zh(this);
      }
      function zh(a) {
        var b = xh(a.Pf);
        a.J = new b("c:" + a.id + ":" + a.ff++, a.F, void 0, a.Bb);
        a.Re = b.responsesRequiredToBeHealthy || 0;
        var c = Ah(a, a.J),
            d = Bh(a, a.J);
        a.hd = a.J;
        a.cd = a.J;
        a.D = null;
        a.Ab = !1;
        setTimeout(function() {
          a.J && a.J.open(c, d);
        }, Math.floor(0));
        b = b.healthyTimeout || 0;
        0 < b && (a.yd = setTimeout(function() {
          a.yd = null;
          a.Ab || (a.J && 102400 < a.J.nb ? (a.f("Connection exceeded healthy timeout but has received " + a.J.nb + " bytes.  Marking connection healthy."), a.Ab = !0, a.J.Ed()) : a.J && 10240 < a.J.ob ? a.f("Connection exceeded healthy timeout but has sent " + a.J.ob + " bytes.  Leaving connection alive.") : (a.f("Closing unhealthy connection after timeout."), a.close()));
        }, Math.floor(b)));
      }
      function Bh(a, b) {
        return function(c) {
          b === a.J ? (a.J = null, c || 0 !== a.Ta ? 1 === a.Ta && a.f("Realtime connection lost.") : (a.f("Realtime connection failed."), "s-" === a.F.Ya.substr(0, 2) && (xc.remove("host:" + a.F.host), a.F.Ya = a.F.host)), a.close()) : b === a.D ? (a.f("Secondary connection lost."), c = a.D, a.D = null, a.hd !== c && a.cd !== c || a.close()) : a.f("closing an old connection");
        };
      }
      function Ah(a, b) {
        return function(c) {
          if (2 != a.Ta)
            if (b === a.cd) {
              var d = Tc("t", c);
              c = Tc("d", c);
              if ("c" == d) {
                if (d = Tc("t", c), "d" in c)
                  if (c = c.d, "h" === d) {
                    var d = c.ts,
                        e = c.v,
                        f = c.h;
                    a.Nf = c.s;
                    Ac(a.F, f);
                    0 == a.Ta && (a.J.start(), Ch(a, a.J, d), "5" !== e && O("Protocol version mismatch detected"), c = a.Pf, (c = 1 < c.gd.length ? c.gd[1] : null) && Dh(a, c));
                  } else if ("n" === d) {
                    a.f("recvd end transmission on primary");
                    a.cd = a.D;
                    for (c = 0; c < a.Md.length; ++c)
                      a.Id(a.Md[c]);
                    a.Md = [];
                    Eh(a);
                  } else
                    "s" === d ? (a.f("Connection shutdown command received. Shutting down..."), a.Ne && (a.Ne(c), a.Ne = null), a.la = null, a.close()) : "r" === d ? (a.f("Reset packet received.  New host: " + c), Ac(a.F, c), 1 === a.Ta ? a.close() : (Fh(a), zh(a))) : "e" === d ? Nc("Server Error: " + c) : "o" === d ? (a.f("got pong on primary."), Gh(a), Hh(a)) : Nc("Unknown control packet command: " + d);
              } else
                "d" == d && a.Id(c);
            } else if (b === a.D)
              if (d = Tc("t", c), c = Tc("d", c), "c" == d)
                "t" in c && (c = c.t, "a" === c ? Ih(a) : "r" === c ? (a.f("Got a reset on secondary, closing it"), a.D.close(), a.hd !== a.D && a.cd !== a.D || a.close()) : "o" === c && (a.f("got pong on secondary."), a.Mf--, Ih(a)));
              else if ("d" == d)
                a.Md.push(c);
              else
                throw Error("Unknown protocol layer: " + d);
            else
              a.f("message on old connection");
        };
      }
      yh.prototype.Fa = function(a) {
        Jh(this, {
          t: "d",
          d: a
        });
      };
      function Eh(a) {
        a.hd === a.D && a.cd === a.D && (a.f("cleaning up and promoting a connection: " + a.D.re), a.J = a.D, a.D = null);
      }
      function Ih(a) {
        0 >= a.Mf ? (a.f("Secondary connection is healthy."), a.Ab = !0, a.D.Ed(), a.D.start(), a.f("sending client ack on secondary"), a.D.send({
          t: "c",
          d: {
            t: "a",
            d: {}
          }
        }), a.f("Ending transmission on primary"), a.J.send({
          t: "c",
          d: {
            t: "n",
            d: {}
          }
        }), a.hd = a.D, Eh(a)) : (a.f("sending ping on secondary."), a.D.send({
          t: "c",
          d: {
            t: "p",
            d: {}
          }
        }));
      }
      yh.prototype.Id = function(a) {
        Gh(this);
        this.jc(a);
      };
      function Gh(a) {
        a.Ab || (a.Re--, 0 >= a.Re && (a.f("Primary connection is healthy."), a.Ab = !0, a.J.Ed()));
      }
      function Dh(a, b) {
        a.D = new b("c:" + a.id + ":" + a.ff++, a.F, a.Nf);
        a.Mf = b.responsesRequiredToBeHealthy || 0;
        a.D.open(Ah(a, a.D), Bh(a, a.D));
        setTimeout(function() {
          a.D && (a.f("Timed out trying to upgrade."), a.D.close());
        }, Math.floor(6E4));
      }
      function Ch(a, b, c) {
        a.f("Realtime connection established.");
        a.J = b;
        a.Ta = 1;
        a.Wc && (a.Wc(c, a.Nf), a.Wc = null);
        0 === a.Re ? (a.f("Primary connection is healthy."), a.Ab = !0) : setTimeout(function() {
          Hh(a);
        }, Math.floor(5E3));
      }
      function Hh(a) {
        a.Ab || 1 !== a.Ta || (a.f("sending ping on primary."), Jh(a, {
          t: "c",
          d: {
            t: "p",
            d: {}
          }
        }));
      }
      function Jh(a, b) {
        if (1 !== a.Ta)
          throw "Connection is not connected";
        a.hd.send(b);
      }
      yh.prototype.close = function() {
        2 !== this.Ta && (this.f("Closing realtime connection."), this.Ta = 2, Fh(this), this.la && (this.la(), this.la = null));
      };
      function Fh(a) {
        a.f("Shutting down all connections");
        a.J && (a.J.close(), a.J = null);
        a.D && (a.D.close(), a.D = null);
        a.yd && (clearTimeout(a.yd), a.yd = null);
      }
      ;
      function Kh(a, b, c, d) {
        this.id = Lh++;
        this.f = Mc("p:" + this.id + ":");
        this.xf = this.Ee = !1;
        this.$ = {};
        this.qa = [];
        this.Yc = 0;
        this.Vc = [];
        this.oa = !1;
        this.Za = 1E3;
        this.Fd = 3E5;
        this.Gb = b;
        this.Uc = c;
        this.Oe = d;
        this.F = a;
        this.sb = this.Aa = this.Ia = this.Bb = this.We = null;
        this.Ob = !1;
        this.Td = {};
        this.Lg = 0;
        this.nf = !0;
        this.Lc = this.Ge = null;
        Mh(this, 0);
        He.ub().Eb("visible", this.Cg, this);
        -1 === a.host.indexOf("fblocal") && Ge.ub().Eb("online", this.Ag, this);
      }
      var Lh = 0,
          Nh = 0;
      g = Kh.prototype;
      g.Fa = function(a, b, c) {
        var d = ++this.Lg;
        a = {
          r: d,
          a: a,
          b: b
        };
        this.f(B(a));
        K(this.oa, "sendRequest call when we're not connected not allowed.");
        this.Ia.Fa(a);
        c && (this.Td[d] = c);
      };
      g.yf = function(a, b, c, d) {
        var e = a.va(),
            f = a.path.toString();
        this.f("Listen called for " + f + " " + e);
        this.$[f] = this.$[f] || {};
        K(fe(a.n) || !S(a.n), "listen() called for non-default but complete query");
        K(!this.$[f][e], "listen() called twice for same path/queryId.");
        a = {
          H: d,
          xd: b,
          Ig: a,
          tag: c
        };
        this.$[f][e] = a;
        this.oa && Oh(this, a);
      };
      function Oh(a, b) {
        var c = b.Ig,
            d = c.path.toString(),
            e = c.va();
        a.f("Listen on " + d + " for " + e);
        var f = {p: d};
        b.tag && (f.q = ee(c.n), f.t = b.tag);
        f.h = b.xd();
        a.Fa("q", f, function(f) {
          var k = f.d,
              l = f.s;
          if (k && "object" === typeof k && v(k, "w")) {
            var m = w(k, "w");
            ea(m) && 0 <= Na(m, "no_index") && O("Using an unspecified index. Consider adding " + ('".indexOn": "' + c.n.g.toString() + '"') + " at " + c.path.toString() + " to your security rules for better performance");
          }
          (a.$[d] && a.$[d][e]) === b && (a.f("listen response", f), "ok" !== l && Ph(a, d, e), b.H && b.H(l, k));
        });
      }
      g.M = function(a, b, c) {
        this.Aa = {
          ig: a,
          of: !1,
          zc: b,
          md: c
        };
        this.f("Authenticating using credential: " + a);
        Qh(this);
        (b = 40 == a.length) || (a = $c(a).Bc, b = "object" === typeof a && !0 === w(a, "admin"));
        b && (this.f("Admin auth credential detected.  Reducing max reconnect time."), this.Fd = 3E4);
      };
      g.ge = function(a) {
        delete this.Aa;
        this.oa && this.Fa("unauth", {}, function(b) {
          a(b.s, b.d);
        });
      };
      function Qh(a) {
        var b = a.Aa;
        a.oa && b && a.Fa("auth", {cred: b.ig}, function(c) {
          var d = c.s;
          c = c.d || "error";
          "ok" !== d && a.Aa === b && delete a.Aa;
          b.of ? "ok" !== d && b.md && b.md(d, c) : (b.of = !0, b.zc && b.zc(d, c));
        });
      }
      g.Rf = function(a, b) {
        var c = a.path.toString(),
            d = a.va();
        this.f("Unlisten called for " + c + " " + d);
        K(fe(a.n) || !S(a.n), "unlisten() called for non-default but complete query");
        if (Ph(this, c, d) && this.oa) {
          var e = ee(a.n);
          this.f("Unlisten on " + c + " for " + d);
          c = {p: c};
          b && (c.q = e, c.t = b);
          this.Fa("n", c);
        }
      };
      g.Me = function(a, b, c) {
        this.oa ? Rh(this, "o", a, b, c) : this.Vc.push({
          $c: a,
          action: "o",
          data: b,
          H: c
        });
      };
      g.Cf = function(a, b, c) {
        this.oa ? Rh(this, "om", a, b, c) : this.Vc.push({
          $c: a,
          action: "om",
          data: b,
          H: c
        });
      };
      g.Jd = function(a, b) {
        this.oa ? Rh(this, "oc", a, null, b) : this.Vc.push({
          $c: a,
          action: "oc",
          data: null,
          H: b
        });
      };
      function Rh(a, b, c, d, e) {
        c = {
          p: c,
          d: d
        };
        a.f("onDisconnect " + b, c);
        a.Fa(b, c, function(a) {
          e && setTimeout(function() {
            e(a.s, a.d);
          }, Math.floor(0));
        });
      }
      g.put = function(a, b, c, d) {
        Sh(this, "p", a, b, c, d);
      };
      g.zf = function(a, b, c, d) {
        Sh(this, "m", a, b, c, d);
      };
      function Sh(a, b, c, d, e, f) {
        d = {
          p: c,
          d: d
        };
        n(f) && (d.h = f);
        a.qa.push({
          action: b,
          Jf: d,
          H: e
        });
        a.Yc++;
        b = a.qa.length - 1;
        a.oa ? Th(a, b) : a.f("Buffering put: " + c);
      }
      function Th(a, b) {
        var c = a.qa[b].action,
            d = a.qa[b].Jf,
            e = a.qa[b].H;
        a.qa[b].Jg = a.oa;
        a.Fa(c, d, function(d) {
          a.f(c + " response", d);
          delete a.qa[b];
          a.Yc--;
          0 === a.Yc && (a.qa = []);
          e && e(d.s, d.d);
        });
      }
      g.Ue = function(a) {
        this.oa && (a = {c: a}, this.f("reportStats", a), this.Fa("s", a, function(a) {
          "ok" !== a.s && this.f("reportStats", "Error sending stats: " + a.d);
        }));
      };
      g.Id = function(a) {
        if ("r" in a) {
          this.f("from server: " + B(a));
          var b = a.r,
              c = this.Td[b];
          c && (delete this.Td[b], c(a.b));
        } else {
          if ("error" in a)
            throw "A server-side error has occurred: " + a.error;
          "a" in a && (b = a.a, c = a.b, this.f("handleServerMessage", b, c), "d" === b ? this.Gb(c.p, c.d, !1, c.t) : "m" === b ? this.Gb(c.p, c.d, !0, c.t) : "c" === b ? Uh(this, c.p, c.q) : "ac" === b ? (a = c.s, b = c.d, c = this.Aa, delete this.Aa, c && c.md && c.md(a, b)) : "sd" === b ? this.We ? this.We(c) : "msg" in c && "undefined" !== typeof console && console.log("FIREBASE: " + c.msg.replace("\n", "\nFIREBASE: ")) : Nc("Unrecognized action received from server: " + B(b) + "\nAre you using the latest client?"));
        }
      };
      g.Wc = function(a, b) {
        this.f("connection ready");
        this.oa = !0;
        this.Lc = (new Date).getTime();
        this.Oe({serverTimeOffset: a - (new Date).getTime()});
        this.Bb = b;
        if (this.nf) {
          var c = {};
          c["sdk.js." + hb.replace(/\./g, "-")] = 1;
          yg() && (c["framework.cordova"] = 1);
          this.Ue(c);
        }
        Vh(this);
        this.nf = !1;
        this.Uc(!0);
      };
      function Mh(a, b) {
        K(!a.Ia, "Scheduling a connect when we're already connected/ing?");
        a.sb && clearTimeout(a.sb);
        a.sb = setTimeout(function() {
          a.sb = null;
          Wh(a);
        }, Math.floor(b));
      }
      g.Cg = function(a) {
        a && !this.Ob && this.Za === this.Fd && (this.f("Window became visible.  Reducing delay."), this.Za = 1E3, this.Ia || Mh(this, 0));
        this.Ob = a;
      };
      g.Ag = function(a) {
        a ? (this.f("Browser went online."), this.Za = 1E3, this.Ia || Mh(this, 0)) : (this.f("Browser went offline.  Killing connection."), this.Ia && this.Ia.close());
      };
      g.Df = function() {
        this.f("data client disconnected");
        this.oa = !1;
        this.Ia = null;
        for (var a = 0; a < this.qa.length; a++) {
          var b = this.qa[a];
          b && "h" in b.Jf && b.Jg && (b.H && b.H("disconnect"), delete this.qa[a], this.Yc--);
        }
        0 === this.Yc && (this.qa = []);
        this.Td = {};
        Xh(this) && (this.Ob ? this.Lc && (3E4 < (new Date).getTime() - this.Lc && (this.Za = 1E3), this.Lc = null) : (this.f("Window isn't visible.  Delaying reconnect."), this.Za = this.Fd, this.Ge = (new Date).getTime()), a = Math.max(0, this.Za - ((new Date).getTime() - this.Ge)), a *= Math.random(), this.f("Trying to reconnect in " + a + "ms"), Mh(this, a), this.Za = Math.min(this.Fd, 1.3 * this.Za));
        this.Uc(!1);
      };
      function Wh(a) {
        if (Xh(a)) {
          a.f("Making a connection attempt");
          a.Ge = (new Date).getTime();
          a.Lc = null;
          var b = q(a.Id, a),
              c = q(a.Wc, a),
              d = q(a.Df, a),
              e = a.id + ":" + Nh++;
          a.Ia = new yh(e, a.F, b, c, d, function(b) {
            O(b + " (" + a.F.toString() + ")");
            a.xf = !0;
          }, a.Bb);
        }
      }
      g.yb = function() {
        this.Ee = !0;
        this.Ia ? this.Ia.close() : (this.sb && (clearTimeout(this.sb), this.sb = null), this.oa && this.Df());
      };
      g.rc = function() {
        this.Ee = !1;
        this.Za = 1E3;
        this.Ia || Mh(this, 0);
      };
      function Uh(a, b, c) {
        c = c ? Qa(c, function(a) {
          return Uc(a);
        }).join("$") : "default";
        (a = Ph(a, b, c)) && a.H && a.H("permission_denied");
      }
      function Ph(a, b, c) {
        b = (new L(b)).toString();
        var d;
        n(a.$[b]) ? (d = a.$[b][c], delete a.$[b][c], 0 === pa(a.$[b]) && delete a.$[b]) : d = void 0;
        return d;
      }
      function Vh(a) {
        Qh(a);
        r(a.$, function(b) {
          r(b, function(b) {
            Oh(a, b);
          });
        });
        for (var b = 0; b < a.qa.length; b++)
          a.qa[b] && Th(a, b);
        for (; a.Vc.length; )
          b = a.Vc.shift(), Rh(a, b.action, b.$c, b.data, b.H);
      }
      function Xh(a) {
        var b;
        b = Ge.ub().kc;
        return !a.xf && !a.Ee && b;
      }
      ;
      var V = {og: function() {
          ih = rh = !0;
        }};
      V.forceLongPolling = V.og;
      V.pg = function() {
        jh = !0;
      };
      V.forceWebSockets = V.pg;
      V.Pg = function(a, b) {
        a.k.Ra.We = b;
      };
      V.setSecurityDebugCallback = V.Pg;
      V.Ye = function(a, b) {
        a.k.Ye(b);
      };
      V.stats = V.Ye;
      V.Ze = function(a, b) {
        a.k.Ze(b);
      };
      V.statsIncrementCounter = V.Ze;
      V.sd = function(a) {
        return a.k.sd;
      };
      V.dataUpdateCount = V.sd;
      V.sg = function(a, b) {
        a.k.De = b;
      };
      V.interceptServerData = V.sg;
      V.yg = function(a) {
        new Ig(a);
      };
      V.onPopupOpen = V.yg;
      V.Ng = function(a) {
        sg = a;
      };
      V.setAuthenticationServer = V.Ng;
      function Q(a, b, c) {
        this.A = a;
        this.W = b;
        this.g = c;
      }
      Q.prototype.I = function() {
        x("Firebase.DataSnapshot.val", 0, 0, arguments.length);
        return this.A.I();
      };
      Q.prototype.val = Q.prototype.I;
      Q.prototype.mf = function() {
        x("Firebase.DataSnapshot.exportVal", 0, 0, arguments.length);
        return this.A.I(!0);
      };
      Q.prototype.exportVal = Q.prototype.mf;
      Q.prototype.ng = function() {
        x("Firebase.DataSnapshot.exists", 0, 0, arguments.length);
        return !this.A.e();
      };
      Q.prototype.exists = Q.prototype.ng;
      Q.prototype.u = function(a) {
        x("Firebase.DataSnapshot.child", 0, 1, arguments.length);
        ga(a) && (a = String(a));
        ig("Firebase.DataSnapshot.child", a);
        var b = new L(a),
            c = this.W.u(b);
        return new Q(this.A.Q(b), c, N);
      };
      Q.prototype.child = Q.prototype.u;
      Q.prototype.Da = function(a) {
        x("Firebase.DataSnapshot.hasChild", 1, 1, arguments.length);
        ig("Firebase.DataSnapshot.hasChild", a);
        var b = new L(a);
        return !this.A.Q(b).e();
      };
      Q.prototype.hasChild = Q.prototype.Da;
      Q.prototype.C = function() {
        x("Firebase.DataSnapshot.getPriority", 0, 0, arguments.length);
        return this.A.C().I();
      };
      Q.prototype.getPriority = Q.prototype.C;
      Q.prototype.forEach = function(a) {
        x("Firebase.DataSnapshot.forEach", 1, 1, arguments.length);
        A("Firebase.DataSnapshot.forEach", 1, a, !1);
        if (this.A.K())
          return !1;
        var b = this;
        return !!this.A.P(this.g, function(c, d) {
          return a(new Q(d, b.W.u(c), N));
        });
      };
      Q.prototype.forEach = Q.prototype.forEach;
      Q.prototype.wd = function() {
        x("Firebase.DataSnapshot.hasChildren", 0, 0, arguments.length);
        return this.A.K() ? !1 : !this.A.e();
      };
      Q.prototype.hasChildren = Q.prototype.wd;
      Q.prototype.name = function() {
        O("Firebase.DataSnapshot.name() being deprecated. Please use Firebase.DataSnapshot.key() instead.");
        x("Firebase.DataSnapshot.name", 0, 0, arguments.length);
        return this.key();
      };
      Q.prototype.name = Q.prototype.name;
      Q.prototype.key = function() {
        x("Firebase.DataSnapshot.key", 0, 0, arguments.length);
        return this.W.key();
      };
      Q.prototype.key = Q.prototype.key;
      Q.prototype.Db = function() {
        x("Firebase.DataSnapshot.numChildren", 0, 0, arguments.length);
        return this.A.Db();
      };
      Q.prototype.numChildren = Q.prototype.Db;
      Q.prototype.Ib = function() {
        x("Firebase.DataSnapshot.ref", 0, 0, arguments.length);
        return this.W;
      };
      Q.prototype.ref = Q.prototype.Ib;
      function Yh(a, b) {
        this.F = a;
        this.Ua = Rb(a);
        this.fd = null;
        this.da = new vb;
        this.Hd = 1;
        this.Ra = null;
        b || 0 <= ("object" === typeof window && window.navigator && window.navigator.userAgent || "").search(/googlebot|google webmaster tools|bingbot|yahoo! slurp|baiduspider|yandexbot|duckduckbot/i) ? (this.ba = new Ae(this.F, q(this.Gb, this)), setTimeout(q(this.Uc, this, !0), 0)) : this.ba = this.Ra = new Kh(this.F, q(this.Gb, this), q(this.Uc, this), q(this.Oe, this));
        this.Sg = Sb(a, q(function() {
          return new Mb(this.Ua, this.ba);
        }, this));
        this.uc = new Rf;
        this.Ce = new ob;
        var c = this;
        this.Cd = new vf({
          Xe: function(a, b, f, h) {
            b = [];
            f = c.Ce.j(a.path);
            f.e() || (b = xf(c.Cd, new Xb(bf, a.path, f)), setTimeout(function() {
              h("ok");
            }, 0));
            return b;
          },
          ae: ba
        });
        Zh(this, "connected", !1);
        this.la = new qc;
        this.M = new Sg(a, q(this.ba.M, this.ba), q(this.ba.ge, this.ba), q(this.Le, this));
        this.sd = 0;
        this.De = null;
        this.L = new vf({
          Xe: function(a, b, f, h) {
            c.ba.yf(a, f, b, function(b, e) {
              var f = h(b, e);
              Ab(c.da, a.path, f);
            });
            return [];
          },
          ae: function(a, b) {
            c.ba.Rf(a, b);
          }
        });
      }
      g = Yh.prototype;
      g.toString = function() {
        return (this.F.kb ? "https://" : "http://") + this.F.host;
      };
      g.name = function() {
        return this.F.hc;
      };
      function $h(a) {
        a = a.Ce.j(new L(".info/serverTimeOffset")).I() || 0;
        return (new Date).getTime() + a;
      }
      function ai(a) {
        a = a = {timestamp: $h(a)};
        a.timestamp = a.timestamp || (new Date).getTime();
        return a;
      }
      g.Gb = function(a, b, c, d) {
        this.sd++;
        var e = new L(a);
        b = this.De ? this.De(a, b) : b;
        a = [];
        d ? c ? (b = na(b, function(a) {
          return M(a);
        }), a = Ff(this.L, e, b, d)) : (b = M(b), a = Bf(this.L, e, b, d)) : c ? (d = na(b, function(a) {
          return M(a);
        }), a = Af(this.L, e, d)) : (d = M(b), a = xf(this.L, new Xb(bf, e, d)));
        d = e;
        0 < a.length && (d = bi(this, e));
        Ab(this.da, d, a);
      };
      g.Uc = function(a) {
        Zh(this, "connected", a);
        !1 === a && ci(this);
      };
      g.Oe = function(a) {
        var b = this;
        Wc(a, function(a, d) {
          Zh(b, d, a);
        });
      };
      g.Le = function(a) {
        Zh(this, "authenticated", a);
      };
      function Zh(a, b, c) {
        b = new L("/.info/" + b);
        c = M(c);
        var d = a.Ce;
        d.Wd = d.Wd.G(b, c);
        c = xf(a.Cd, new Xb(bf, b, c));
        Ab(a.da, b, c);
      }
      g.Kb = function(a, b, c, d) {
        this.f("set", {
          path: a.toString(),
          value: b,
          $g: c
        });
        var e = ai(this);
        b = M(b, c);
        var e = sc(b, e),
            f = this.Hd++,
            e = wf(this.L, a, e, f, !0);
        wb(this.da, e);
        var h = this;
        this.ba.put(a.toString(), b.I(!0), function(b, c) {
          var e = "ok" === b;
          e || O("set at " + a + " failed: " + b);
          e = zf(h.L, f, !e);
          Ab(h.da, a, e);
          di(d, b, c);
        });
        e = ei(this, a);
        bi(this, e);
        Ab(this.da, e, []);
      };
      g.update = function(a, b, c) {
        this.f("update", {
          path: a.toString(),
          value: b
        });
        var d = !0,
            e = ai(this),
            f = {};
        r(b, function(a, b) {
          d = !1;
          var c = M(a);
          f[b] = sc(c, e);
        });
        if (d)
          Cb("update() called with empty data.  Don't do anything."), di(c, "ok");
        else {
          var h = this.Hd++,
              k = yf(this.L, a, f, h);
          wb(this.da, k);
          var l = this;
          this.ba.zf(a.toString(), b, function(b, d) {
            var e = "ok" === b;
            e || O("update at " + a + " failed: " + b);
            var e = zf(l.L, h, !e),
                f = a;
            0 < e.length && (f = bi(l, a));
            Ab(l.da, f, e);
            di(c, b, d);
          });
          b = ei(this, a);
          bi(this, b);
          Ab(this.da, a, []);
        }
      };
      function ci(a) {
        a.f("onDisconnectEvents");
        var b = ai(a),
            c = [];
        rc(pc(a.la, b), G, function(b, e) {
          c = c.concat(xf(a.L, new Xb(bf, b, e)));
          var f = ei(a, b);
          bi(a, f);
        });
        a.la = new qc;
        Ab(a.da, G, c);
      }
      g.Jd = function(a, b) {
        var c = this;
        this.ba.Jd(a.toString(), function(d, e) {
          "ok" === d && rg(c.la, a);
          di(b, d, e);
        });
      };
      function fi(a, b, c, d) {
        var e = M(c);
        a.ba.Me(b.toString(), e.I(!0), function(c, h) {
          "ok" === c && a.la.nc(b, e);
          di(d, c, h);
        });
      }
      function gi(a, b, c, d, e) {
        var f = M(c, d);
        a.ba.Me(b.toString(), f.I(!0), function(c, d) {
          "ok" === c && a.la.nc(b, f);
          di(e, c, d);
        });
      }
      function hi(a, b, c, d) {
        var e = !0,
            f;
        for (f in c)
          e = !1;
        e ? (Cb("onDisconnect().update() called with empty data.  Don't do anything."), di(d, "ok")) : a.ba.Cf(b.toString(), c, function(e, f) {
          if ("ok" === e)
            for (var l in c) {
              var m = M(c[l]);
              a.la.nc(b.u(l), m);
            }
          di(d, e, f);
        });
      }
      function ii(a, b, c) {
        c = ".info" === E(b.path) ? a.Cd.Pb(b, c) : a.L.Pb(b, c);
        yb(a.da, b.path, c);
      }
      g.yb = function() {
        this.Ra && this.Ra.yb();
      };
      g.rc = function() {
        this.Ra && this.Ra.rc();
      };
      g.Ye = function(a) {
        if ("undefined" !== typeof console) {
          a ? (this.fd || (this.fd = new Lb(this.Ua)), a = this.fd.get()) : a = this.Ua.get();
          var b = Ra(sa(a), function(a, b) {
            return Math.max(b.length, a);
          }, 0),
              c;
          for (c in a) {
            for (var d = a[c],
                e = c.length; e < b + 2; e++)
              c += " ";
            console.log(c + d);
          }
        }
      };
      g.Ze = function(a) {
        Ob(this.Ua, a);
        this.Sg.Of[a] = !0;
      };
      g.f = function(a) {
        var b = "";
        this.Ra && (b = this.Ra.id + ":");
        Cb(b, arguments);
      };
      function di(a, b, c) {
        a && Db(function() {
          if ("ok" == b)
            a(null);
          else {
            var d = (b || "error").toUpperCase(),
                e = d;
            c && (e += ": " + c);
            e = Error(e);
            e.code = d;
            a(e);
          }
        });
      }
      ;
      function ji(a, b, c, d, e) {
        function f() {}
        a.f("transaction on " + b);
        var h = new U(a, b);
        h.Eb("value", f);
        c = {
          path: b,
          update: c,
          H: d,
          status: null,
          Ff: Ec(),
          cf: e,
          Lf: 0,
          ie: function() {
            h.ic("value", f);
          },
          ke: null,
          Ba: null,
          pd: null,
          qd: null,
          rd: null
        };
        d = a.L.za(b, void 0) || C;
        c.pd = d;
        d = c.update(d.I());
        if (n(d)) {
          cg("transaction failed: Data returned ", d, c.path);
          c.status = 1;
          e = Sf(a.uc, b);
          var k = e.Ca() || [];
          k.push(c);
          Tf(e, k);
          "object" === typeof d && null !== d && v(d, ".priority") ? (k = w(d, ".priority"), K(ag(k), "Invalid priority returned by transaction. Priority must be a valid string, finite number, server value, or null.")) : k = (a.L.za(b) || C).C().I();
          e = ai(a);
          d = M(d, k);
          e = sc(d, e);
          c.qd = d;
          c.rd = e;
          c.Ba = a.Hd++;
          c = wf(a.L, b, e, c.Ba, c.cf);
          Ab(a.da, b, c);
          ki(a);
        } else
          c.ie(), c.qd = null, c.rd = null, c.H && (a = new Q(c.pd, new U(a, c.path), N), c.H(null, !1, a));
      }
      function ki(a, b) {
        var c = b || a.uc;
        b || li(a, c);
        if (null !== c.Ca()) {
          var d = mi(a, c);
          K(0 < d.length, "Sending zero length transaction queue");
          Sa(d, function(a) {
            return 1 === a.status;
          }) && ni(a, c.path(), d);
        } else
          c.wd() && c.P(function(b) {
            ki(a, b);
          });
      }
      function ni(a, b, c) {
        for (var d = Qa(c, function(a) {
          return a.Ba;
        }),
            e = a.L.za(b, d) || C,
            d = e,
            e = e.hash(),
            f = 0; f < c.length; f++) {
          var h = c[f];
          K(1 === h.status, "tryToSendTransactionQueue_: items in queue should all be run.");
          h.status = 2;
          h.Lf++;
          var k = T(b, h.path),
              d = d.G(k, h.qd);
        }
        d = d.I(!0);
        a.ba.put(b.toString(), d, function(d) {
          a.f("transaction put response", {
            path: b.toString(),
            status: d
          });
          var e = [];
          if ("ok" === d) {
            d = [];
            for (f = 0; f < c.length; f++) {
              c[f].status = 3;
              e = e.concat(zf(a.L, c[f].Ba));
              if (c[f].H) {
                var h = c[f].rd,
                    k = new U(a, c[f].path);
                d.push(q(c[f].H, null, null, !0, new Q(h, k, N)));
              }
              c[f].ie();
            }
            li(a, Sf(a.uc, b));
            ki(a);
            Ab(a.da, b, e);
            for (f = 0; f < d.length; f++)
              Db(d[f]);
          } else {
            if ("datastale" === d)
              for (f = 0; f < c.length; f++)
                c[f].status = 4 === c[f].status ? 5 : 1;
            else
              for (O("transaction at " + b.toString() + " failed: " + d), f = 0; f < c.length; f++)
                c[f].status = 5, c[f].ke = d;
            bi(a, b);
          }
        }, e);
      }
      function bi(a, b) {
        var c = oi(a, b),
            d = c.path(),
            c = mi(a, c);
        pi(a, c, d);
        return d;
      }
      function pi(a, b, c) {
        if (0 !== b.length) {
          for (var d = [],
              e = [],
              f = Qa(b, function(a) {
                return a.Ba;
              }),
              h = 0; h < b.length; h++) {
            var k = b[h],
                l = T(c, k.path),
                m = !1,
                t;
            K(null !== l, "rerunTransactionsUnderNode_: relativePath should not be null.");
            if (5 === k.status)
              m = !0, t = k.ke, e = e.concat(zf(a.L, k.Ba, !0));
            else if (1 === k.status)
              if (25 <= k.Lf)
                m = !0, t = "maxretry", e = e.concat(zf(a.L, k.Ba, !0));
              else {
                var z = a.L.za(k.path, f) || C;
                k.pd = z;
                var I = b[h].update(z.I());
                n(I) ? (cg("transaction failed: Data returned ", I, k.path), l = M(I), "object" === typeof I && null != I && v(I, ".priority") || (l = l.ga(z.C())), z = k.Ba, I = ai(a), I = sc(l, I), k.qd = l, k.rd = I, k.Ba = a.Hd++, Va(f, z), e = e.concat(wf(a.L, k.path, I, k.Ba, k.cf)), e = e.concat(zf(a.L, z, !0))) : (m = !0, t = "nodata", e = e.concat(zf(a.L, k.Ba, !0)));
              }
            Ab(a.da, c, e);
            e = [];
            m && (b[h].status = 3, setTimeout(b[h].ie, Math.floor(0)), b[h].H && ("nodata" === t ? (k = new U(a, b[h].path), d.push(q(b[h].H, null, null, !1, new Q(b[h].pd, k, N)))) : d.push(q(b[h].H, null, Error(t), !1, null))));
          }
          li(a, a.uc);
          for (h = 0; h < d.length; h++)
            Db(d[h]);
          ki(a);
        }
      }
      function oi(a, b) {
        for (var c,
            d = a.uc; null !== (c = E(b)) && null === d.Ca(); )
          d = Sf(d, c), b = H(b);
        return d;
      }
      function mi(a, b) {
        var c = [];
        qi(a, b, c);
        c.sort(function(a, b) {
          return a.Ff - b.Ff;
        });
        return c;
      }
      function qi(a, b, c) {
        var d = b.Ca();
        if (null !== d)
          for (var e = 0; e < d.length; e++)
            c.push(d[e]);
        b.P(function(b) {
          qi(a, b, c);
        });
      }
      function li(a, b) {
        var c = b.Ca();
        if (c) {
          for (var d = 0,
              e = 0; e < c.length; e++)
            3 !== c[e].status && (c[d] = c[e], d++);
          c.length = d;
          Tf(b, 0 < c.length ? c : null);
        }
        b.P(function(b) {
          li(a, b);
        });
      }
      function ei(a, b) {
        var c = oi(a, b).path(),
            d = Sf(a.uc, b);
        Wf(d, function(b) {
          ri(a, b);
        });
        ri(a, d);
        Vf(d, function(b) {
          ri(a, b);
        });
        return c;
      }
      function ri(a, b) {
        var c = b.Ca();
        if (null !== c) {
          for (var d = [],
              e = [],
              f = -1,
              h = 0; h < c.length; h++)
            4 !== c[h].status && (2 === c[h].status ? (K(f === h - 1, "All SENT items should be at beginning of queue."), f = h, c[h].status = 4, c[h].ke = "set") : (K(1 === c[h].status, "Unexpected transaction status in abort"), c[h].ie(), e = e.concat(zf(a.L, c[h].Ba, !0)), c[h].H && d.push(q(c[h].H, null, Error("set"), !1, null))));
          -1 === f ? Tf(b, null) : c.length = f + 1;
          Ab(a.da, b.path(), e);
          for (h = 0; h < d.length; h++)
            Db(d[h]);
        }
      }
      ;
      function W() {
        this.oc = {};
        this.Sf = !1;
      }
      W.prototype.yb = function() {
        for (var a in this.oc)
          this.oc[a].yb();
      };
      W.prototype.rc = function() {
        for (var a in this.oc)
          this.oc[a].rc();
      };
      W.prototype.ve = function() {
        this.Sf = !0;
      };
      ca(W);
      W.prototype.interrupt = W.prototype.yb;
      W.prototype.resume = W.prototype.rc;
      function X(a, b) {
        this.bd = a;
        this.ra = b;
      }
      X.prototype.cancel = function(a) {
        x("Firebase.onDisconnect().cancel", 0, 1, arguments.length);
        A("Firebase.onDisconnect().cancel", 1, a, !0);
        this.bd.Jd(this.ra, a || null);
      };
      X.prototype.cancel = X.prototype.cancel;
      X.prototype.remove = function(a) {
        x("Firebase.onDisconnect().remove", 0, 1, arguments.length);
        jg("Firebase.onDisconnect().remove", this.ra);
        A("Firebase.onDisconnect().remove", 1, a, !0);
        fi(this.bd, this.ra, null, a);
      };
      X.prototype.remove = X.prototype.remove;
      X.prototype.set = function(a, b) {
        x("Firebase.onDisconnect().set", 1, 2, arguments.length);
        jg("Firebase.onDisconnect().set", this.ra);
        bg("Firebase.onDisconnect().set", a, this.ra, !1);
        A("Firebase.onDisconnect().set", 2, b, !0);
        fi(this.bd, this.ra, a, b);
      };
      X.prototype.set = X.prototype.set;
      X.prototype.Kb = function(a, b, c) {
        x("Firebase.onDisconnect().setWithPriority", 2, 3, arguments.length);
        jg("Firebase.onDisconnect().setWithPriority", this.ra);
        bg("Firebase.onDisconnect().setWithPriority", a, this.ra, !1);
        fg("Firebase.onDisconnect().setWithPriority", 2, b);
        A("Firebase.onDisconnect().setWithPriority", 3, c, !0);
        gi(this.bd, this.ra, a, b, c);
      };
      X.prototype.setWithPriority = X.prototype.Kb;
      X.prototype.update = function(a, b) {
        x("Firebase.onDisconnect().update", 1, 2, arguments.length);
        jg("Firebase.onDisconnect().update", this.ra);
        if (ea(a)) {
          for (var c = {},
              d = 0; d < a.length; ++d)
            c["" + d] = a[d];
          a = c;
          O("Passing an Array to Firebase.onDisconnect().update() is deprecated. Use set() if you want to overwrite the existing data, or an Object with integer keys if you really do want to only update some of the children.");
        }
        eg("Firebase.onDisconnect().update", a, this.ra);
        A("Firebase.onDisconnect().update", 2, b, !0);
        hi(this.bd, this.ra, a, b);
      };
      X.prototype.update = X.prototype.update;
      function Y(a, b, c, d) {
        this.k = a;
        this.path = b;
        this.n = c;
        this.lc = d;
      }
      function si(a) {
        var b = null,
            c = null;
        a.ma && (b = nd(a));
        a.pa && (c = pd(a));
        if (a.g === Qd) {
          if (a.ma) {
            if ("[MIN_NAME]" != md(a))
              throw Error("Query: When ordering by key, you may only pass one argument to startAt(), endAt(), or equalTo().");
            if ("string" !== typeof b)
              throw Error("Query: When ordering by key, the argument passed to startAt(), endAt(),or equalTo() must be a string.");
          }
          if (a.pa) {
            if ("[MAX_NAME]" != od(a))
              throw Error("Query: When ordering by key, you may only pass one argument to startAt(), endAt(), or equalTo().");
            if ("string" !== typeof c)
              throw Error("Query: When ordering by key, the argument passed to startAt(), endAt(),or equalTo() must be a string.");
          }
        } else if (a.g === N) {
          if (null != b && !ag(b) || null != c && !ag(c))
            throw Error("Query: When ordering by priority, the first argument passed to startAt(), endAt(), or equalTo() must be a valid priority value (null, a number, or a string).");
        } else if (K(a.g instanceof Ud || a.g === $d, "unknown index type."), null != b && "object" === typeof b || null != c && "object" === typeof c)
          throw Error("Query: First argument passed to startAt(), endAt(), or equalTo() cannot be an object.");
      }
      function ti(a) {
        if (a.ma && a.pa && a.ja && (!a.ja || "" === a.Nb))
          throw Error("Query: Can't combine startAt(), endAt(), and limit(). Use limitToFirst() or limitToLast() instead.");
      }
      function ui(a, b) {
        if (!0 === a.lc)
          throw Error(b + ": You can't combine multiple orderBy calls.");
      }
      g = Y.prototype;
      g.Ib = function() {
        x("Query.ref", 0, 0, arguments.length);
        return new U(this.k, this.path);
      };
      g.Eb = function(a, b, c, d) {
        x("Query.on", 2, 4, arguments.length);
        gg("Query.on", a, !1);
        A("Query.on", 2, b, !1);
        var e = vi("Query.on", c, d);
        if ("value" === a)
          ii(this.k, this, new id(b, e.cancel || null, e.Ma || null));
        else {
          var f = {};
          f[a] = b;
          ii(this.k, this, new jd(f, e.cancel, e.Ma));
        }
        return b;
      };
      g.ic = function(a, b, c) {
        x("Query.off", 0, 3, arguments.length);
        gg("Query.off", a, !0);
        A("Query.off", 2, b, !0);
        mb("Query.off", 3, c);
        var d = null,
            e = null;
        "value" === a ? d = new id(b || null, null, c || null) : a && (b && (e = {}, e[a] = b), d = new jd(e, null, c || null));
        e = this.k;
        d = ".info" === E(this.path) ? e.Cd.jb(this, d) : e.L.jb(this, d);
        yb(e.da, this.path, d);
      };
      g.Dg = function(a, b) {
        function c(h) {
          f && (f = !1, e.ic(a, c), b.call(d.Ma, h));
        }
        x("Query.once", 2, 4, arguments.length);
        gg("Query.once", a, !1);
        A("Query.once", 2, b, !1);
        var d = vi("Query.once", arguments[2], arguments[3]),
            e = this,
            f = !0;
        this.Eb(a, c, function(b) {
          e.ic(a, c);
          d.cancel && d.cancel.call(d.Ma, b);
        });
      };
      g.He = function(a) {
        O("Query.limit() being deprecated. Please use Query.limitToFirst() or Query.limitToLast() instead.");
        x("Query.limit", 1, 1, arguments.length);
        if (!ga(a) || Math.floor(a) !== a || 0 >= a)
          throw Error("Query.limit: First argument must be a positive integer.");
        if (this.n.ja)
          throw Error("Query.limit: Limit was already set (by another call to limit, limitToFirst, orlimitToLast.");
        var b = this.n.He(a);
        ti(b);
        return new Y(this.k, this.path, b, this.lc);
      };
      g.Ie = function(a) {
        x("Query.limitToFirst", 1, 1, arguments.length);
        if (!ga(a) || Math.floor(a) !== a || 0 >= a)
          throw Error("Query.limitToFirst: First argument must be a positive integer.");
        if (this.n.ja)
          throw Error("Query.limitToFirst: Limit was already set (by another call to limit, limitToFirst, or limitToLast).");
        return new Y(this.k, this.path, this.n.Ie(a), this.lc);
      };
      g.Je = function(a) {
        x("Query.limitToLast", 1, 1, arguments.length);
        if (!ga(a) || Math.floor(a) !== a || 0 >= a)
          throw Error("Query.limitToLast: First argument must be a positive integer.");
        if (this.n.ja)
          throw Error("Query.limitToLast: Limit was already set (by another call to limit, limitToFirst, or limitToLast).");
        return new Y(this.k, this.path, this.n.Je(a), this.lc);
      };
      g.Eg = function(a) {
        x("Query.orderByChild", 1, 1, arguments.length);
        if ("$key" === a)
          throw Error('Query.orderByChild: "$key" is invalid.  Use Query.orderByKey() instead.');
        if ("$priority" === a)
          throw Error('Query.orderByChild: "$priority" is invalid.  Use Query.orderByPriority() instead.');
        if ("$value" === a)
          throw Error('Query.orderByChild: "$value" is invalid.  Use Query.orderByValue() instead.');
        ig("Query.orderByChild", a);
        ui(this, "Query.orderByChild");
        var b = new L(a);
        if (b.e())
          throw Error("Query.orderByChild: cannot pass in empty path.  Use Query.orderByValue() instead.");
        b = new Ud(b);
        b = de(this.n, b);
        si(b);
        return new Y(this.k, this.path, b, !0);
      };
      g.Fg = function() {
        x("Query.orderByKey", 0, 0, arguments.length);
        ui(this, "Query.orderByKey");
        var a = de(this.n, Qd);
        si(a);
        return new Y(this.k, this.path, a, !0);
      };
      g.Gg = function() {
        x("Query.orderByPriority", 0, 0, arguments.length);
        ui(this, "Query.orderByPriority");
        var a = de(this.n, N);
        si(a);
        return new Y(this.k, this.path, a, !0);
      };
      g.Hg = function() {
        x("Query.orderByValue", 0, 0, arguments.length);
        ui(this, "Query.orderByValue");
        var a = de(this.n, $d);
        si(a);
        return new Y(this.k, this.path, a, !0);
      };
      g.$d = function(a, b) {
        x("Query.startAt", 0, 2, arguments.length);
        bg("Query.startAt", a, this.path, !0);
        hg("Query.startAt", b);
        var c = this.n.$d(a, b);
        ti(c);
        si(c);
        if (this.n.ma)
          throw Error("Query.startAt: Starting point was already set (by another call to startAt or equalTo).");
        n(a) || (b = a = null);
        return new Y(this.k, this.path, c, this.lc);
      };
      g.td = function(a, b) {
        x("Query.endAt", 0, 2, arguments.length);
        bg("Query.endAt", a, this.path, !0);
        hg("Query.endAt", b);
        var c = this.n.td(a, b);
        ti(c);
        si(c);
        if (this.n.pa)
          throw Error("Query.endAt: Ending point was already set (by another call to endAt or equalTo).");
        return new Y(this.k, this.path, c, this.lc);
      };
      g.kg = function(a, b) {
        x("Query.equalTo", 1, 2, arguments.length);
        bg("Query.equalTo", a, this.path, !1);
        hg("Query.equalTo", b);
        if (this.n.ma)
          throw Error("Query.equalTo: Starting point was already set (by another call to endAt or equalTo).");
        if (this.n.pa)
          throw Error("Query.equalTo: Ending point was already set (by another call to endAt or equalTo).");
        return this.$d(a, b).td(a, b);
      };
      g.toString = function() {
        x("Query.toString", 0, 0, arguments.length);
        for (var a = this.path,
            b = "",
            c = a.Z; c < a.o.length; c++)
          "" !== a.o[c] && (b += "/" + encodeURIComponent(String(a.o[c])));
        return this.k.toString() + (b || "/");
      };
      g.va = function() {
        var a = Uc(ee(this.n));
        return "{}" === a ? "default" : a;
      };
      function vi(a, b, c) {
        var d = {
          cancel: null,
          Ma: null
        };
        if (b && c)
          d.cancel = b, A(a, 3, d.cancel, !0), d.Ma = c, mb(a, 4, d.Ma);
        else if (b)
          if ("object" === typeof b && null !== b)
            d.Ma = b;
          else if ("function" === typeof b)
            d.cancel = b;
          else
            throw Error(y(a, 3, !0) + " must either be a cancel callback or a context object.");
        return d;
      }
      Y.prototype.ref = Y.prototype.Ib;
      Y.prototype.on = Y.prototype.Eb;
      Y.prototype.off = Y.prototype.ic;
      Y.prototype.once = Y.prototype.Dg;
      Y.prototype.limit = Y.prototype.He;
      Y.prototype.limitToFirst = Y.prototype.Ie;
      Y.prototype.limitToLast = Y.prototype.Je;
      Y.prototype.orderByChild = Y.prototype.Eg;
      Y.prototype.orderByKey = Y.prototype.Fg;
      Y.prototype.orderByPriority = Y.prototype.Gg;
      Y.prototype.orderByValue = Y.prototype.Hg;
      Y.prototype.startAt = Y.prototype.$d;
      Y.prototype.endAt = Y.prototype.td;
      Y.prototype.equalTo = Y.prototype.kg;
      Y.prototype.toString = Y.prototype.toString;
      var Z = {};
      Z.vc = Kh;
      Z.DataConnection = Z.vc;
      Kh.prototype.Rg = function(a, b) {
        this.Fa("q", {p: a}, b);
      };
      Z.vc.prototype.simpleListen = Z.vc.prototype.Rg;
      Kh.prototype.jg = function(a, b) {
        this.Fa("echo", {d: a}, b);
      };
      Z.vc.prototype.echo = Z.vc.prototype.jg;
      Kh.prototype.interrupt = Kh.prototype.yb;
      Z.Vf = yh;
      Z.RealTimeConnection = Z.Vf;
      yh.prototype.sendRequest = yh.prototype.Fa;
      yh.prototype.close = yh.prototype.close;
      Z.rg = function(a) {
        var b = Kh.prototype.put;
        Kh.prototype.put = function(c, d, e, f) {
          n(f) && (f = a());
          b.call(this, c, d, e, f);
        };
        return function() {
          Kh.prototype.put = b;
        };
      };
      Z.hijackHash = Z.rg;
      Z.Uf = zc;
      Z.ConnectionTarget = Z.Uf;
      Z.va = function(a) {
        return a.va();
      };
      Z.queryIdentifier = Z.va;
      Z.tg = function(a) {
        return a.k.Ra.$;
      };
      Z.listens = Z.tg;
      Z.ve = function(a) {
        a.ve();
      };
      Z.forceRestClient = Z.ve;
      function U(a, b) {
        var c,
            d,
            e;
        if (a instanceof Yh)
          c = a, d = b;
        else {
          x("new Firebase", 1, 2, arguments.length);
          d = Pc(arguments[0]);
          c = d.Tg;
          "firebase" === d.domain && Oc(d.host + " is no longer supported. Please use <YOUR FIREBASE>.firebaseio.com instead");
          c && "undefined" != c || Oc("Cannot parse Firebase url. Please use https://<YOUR FIREBASE>.firebaseio.com");
          d.kb || "undefined" !== typeof window && window.location && window.location.protocol && -1 !== window.location.protocol.indexOf("https:") && O("Insecure Firebase access from a secure page. Please use https in calls to new Firebase().");
          c = new zc(d.host, d.kb, c, "ws" === d.scheme || "wss" === d.scheme);
          d = new L(d.$c);
          e = d.toString();
          var f;
          !(f = !p(c.host) || 0 === c.host.length || !$f(c.hc)) && (f = 0 !== e.length) && (e && (e = e.replace(/^\/*\.info(\/|$)/, "/")), f = !(p(e) && 0 !== e.length && !Yf.test(e)));
          if (f)
            throw Error(y("new Firebase", 1, !1) + 'must be a valid firebase URL and the path can\'t contain ".", "#", "$", "[", or "]".');
          if (b)
            if (b instanceof W)
              e = b;
            else if (p(b))
              e = W.ub(), c.Od = b;
            else
              throw Error("Expected a valid Firebase.Context for second argument to new Firebase()");
          else
            e = W.ub();
          f = c.toString();
          var h = w(e.oc, f);
          h || (h = new Yh(c, e.Sf), e.oc[f] = h);
          c = h;
        }
        Y.call(this, c, d, be, !1);
      }
      ma(U, Y);
      var wi = U,
          xi = ["Firebase"],
          yi = aa;
      xi[0] in yi || !yi.execScript || yi.execScript("var " + xi[0]);
      for (var zi; xi.length && (zi = xi.shift()); )
        !xi.length && n(wi) ? yi[zi] = wi : yi = yi[zi] ? yi[zi] : yi[zi] = {};
      U.goOffline = function() {
        x("Firebase.goOffline", 0, 0, arguments.length);
        W.ub().yb();
      };
      U.goOnline = function() {
        x("Firebase.goOnline", 0, 0, arguments.length);
        W.ub().rc();
      };
      function Lc(a, b) {
        K(!b || !0 === a || !1 === a, "Can't turn on custom loggers persistently.");
        !0 === a ? ("undefined" !== typeof console && ("function" === typeof console.log ? Bb = q(console.log, console) : "object" === typeof console.log && (Bb = function(a) {
          console.log(a);
        })), b && yc.set("logging_enabled", !0)) : a ? Bb = a : (Bb = null, yc.remove("logging_enabled"));
      }
      U.enableLogging = Lc;
      U.ServerValue = {TIMESTAMP: {".sv": "timestamp"}};
      U.SDK_VERSION = hb;
      U.INTERNAL = V;
      U.Context = W;
      U.TEST_ACCESS = Z;
      U.prototype.name = function() {
        O("Firebase.name() being deprecated. Please use Firebase.key() instead.");
        x("Firebase.name", 0, 0, arguments.length);
        return this.key();
      };
      U.prototype.name = U.prototype.name;
      U.prototype.key = function() {
        x("Firebase.key", 0, 0, arguments.length);
        return this.path.e() ? null : Ld(this.path);
      };
      U.prototype.key = U.prototype.key;
      U.prototype.u = function(a) {
        x("Firebase.child", 1, 1, arguments.length);
        if (ga(a))
          a = String(a);
        else if (!(a instanceof L))
          if (null === E(this.path)) {
            var b = a;
            b && (b = b.replace(/^\/*\.info(\/|$)/, "/"));
            ig("Firebase.child", b);
          } else
            ig("Firebase.child", a);
        return new U(this.k, this.path.u(a));
      };
      U.prototype.child = U.prototype.u;
      U.prototype.parent = function() {
        x("Firebase.parent", 0, 0, arguments.length);
        var a = this.path.parent();
        return null === a ? null : new U(this.k, a);
      };
      U.prototype.parent = U.prototype.parent;
      U.prototype.root = function() {
        x("Firebase.ref", 0, 0, arguments.length);
        for (var a = this; null !== a.parent(); )
          a = a.parent();
        return a;
      };
      U.prototype.root = U.prototype.root;
      U.prototype.set = function(a, b) {
        x("Firebase.set", 1, 2, arguments.length);
        jg("Firebase.set", this.path);
        bg("Firebase.set", a, this.path, !1);
        A("Firebase.set", 2, b, !0);
        this.k.Kb(this.path, a, null, b || null);
      };
      U.prototype.set = U.prototype.set;
      U.prototype.update = function(a, b) {
        x("Firebase.update", 1, 2, arguments.length);
        jg("Firebase.update", this.path);
        if (ea(a)) {
          for (var c = {},
              d = 0; d < a.length; ++d)
            c["" + d] = a[d];
          a = c;
          O("Passing an Array to Firebase.update() is deprecated. Use set() if you want to overwrite the existing data, or an Object with integer keys if you really do want to only update some of the children.");
        }
        eg("Firebase.update", a, this.path);
        A("Firebase.update", 2, b, !0);
        this.k.update(this.path, a, b || null);
      };
      U.prototype.update = U.prototype.update;
      U.prototype.Kb = function(a, b, c) {
        x("Firebase.setWithPriority", 2, 3, arguments.length);
        jg("Firebase.setWithPriority", this.path);
        bg("Firebase.setWithPriority", a, this.path, !1);
        fg("Firebase.setWithPriority", 2, b);
        A("Firebase.setWithPriority", 3, c, !0);
        if (".length" === this.key() || ".keys" === this.key())
          throw "Firebase.setWithPriority failed: " + this.key() + " is a read-only object.";
        this.k.Kb(this.path, a, b, c || null);
      };
      U.prototype.setWithPriority = U.prototype.Kb;
      U.prototype.remove = function(a) {
        x("Firebase.remove", 0, 1, arguments.length);
        jg("Firebase.remove", this.path);
        A("Firebase.remove", 1, a, !0);
        this.set(null, a);
      };
      U.prototype.remove = U.prototype.remove;
      U.prototype.transaction = function(a, b, c) {
        x("Firebase.transaction", 1, 3, arguments.length);
        jg("Firebase.transaction", this.path);
        A("Firebase.transaction", 1, a, !1);
        A("Firebase.transaction", 2, b, !0);
        if (n(c) && "boolean" != typeof c)
          throw Error(y("Firebase.transaction", 3, !0) + "must be a boolean.");
        if (".length" === this.key() || ".keys" === this.key())
          throw "Firebase.transaction failed: " + this.key() + " is a read-only object.";
        "undefined" === typeof c && (c = !0);
        ji(this.k, this.path, a, b || null, c);
      };
      U.prototype.transaction = U.prototype.transaction;
      U.prototype.Og = function(a, b) {
        x("Firebase.setPriority", 1, 2, arguments.length);
        jg("Firebase.setPriority", this.path);
        fg("Firebase.setPriority", 1, a);
        A("Firebase.setPriority", 2, b, !0);
        this.k.Kb(this.path.u(".priority"), a, null, b);
      };
      U.prototype.setPriority = U.prototype.Og;
      U.prototype.push = function(a, b) {
        x("Firebase.push", 0, 2, arguments.length);
        jg("Firebase.push", this.path);
        bg("Firebase.push", a, this.path, !0);
        A("Firebase.push", 2, b, !0);
        var c = $h(this.k),
            c = Fe(c),
            c = this.u(c);
        "undefined" !== typeof a && null !== a && c.set(a, b);
        return c;
      };
      U.prototype.push = U.prototype.push;
      U.prototype.hb = function() {
        jg("Firebase.onDisconnect", this.path);
        return new X(this.k, this.path);
      };
      U.prototype.onDisconnect = U.prototype.hb;
      U.prototype.M = function(a, b, c) {
        O("FirebaseRef.auth() being deprecated. Please use FirebaseRef.authWithCustomToken() instead.");
        x("Firebase.auth", 1, 3, arguments.length);
        kg("Firebase.auth", a);
        A("Firebase.auth", 2, b, !0);
        A("Firebase.auth", 3, b, !0);
        Yg(this.k.M, a, {}, {remember: "none"}, b, c);
      };
      U.prototype.auth = U.prototype.M;
      U.prototype.ge = function(a) {
        x("Firebase.unauth", 0, 1, arguments.length);
        A("Firebase.unauth", 1, a, !0);
        Zg(this.k.M, a);
      };
      U.prototype.unauth = U.prototype.ge;
      U.prototype.xe = function() {
        x("Firebase.getAuth", 0, 0, arguments.length);
        return this.k.M.xe();
      };
      U.prototype.getAuth = U.prototype.xe;
      U.prototype.xg = function(a, b) {
        x("Firebase.onAuth", 1, 2, arguments.length);
        A("Firebase.onAuth", 1, a, !1);
        mb("Firebase.onAuth", 2, b);
        this.k.M.Eb("auth_status", a, b);
      };
      U.prototype.onAuth = U.prototype.xg;
      U.prototype.wg = function(a, b) {
        x("Firebase.offAuth", 1, 2, arguments.length);
        A("Firebase.offAuth", 1, a, !1);
        mb("Firebase.offAuth", 2, b);
        this.k.M.ic("auth_status", a, b);
      };
      U.prototype.offAuth = U.prototype.wg;
      U.prototype.Zf = function(a, b, c) {
        x("Firebase.authWithCustomToken", 2, 3, arguments.length);
        kg("Firebase.authWithCustomToken", a);
        A("Firebase.authWithCustomToken", 2, b, !1);
        ng("Firebase.authWithCustomToken", 3, c, !0);
        Yg(this.k.M, a, {}, c || {}, b);
      };
      U.prototype.authWithCustomToken = U.prototype.Zf;
      U.prototype.$f = function(a, b, c) {
        x("Firebase.authWithOAuthPopup", 2, 3, arguments.length);
        mg("Firebase.authWithOAuthPopup", a);
        A("Firebase.authWithOAuthPopup", 2, b, !1);
        ng("Firebase.authWithOAuthPopup", 3, c, !0);
        ch(this.k.M, a, c, b);
      };
      U.prototype.authWithOAuthPopup = U.prototype.$f;
      U.prototype.ag = function(a, b, c) {
        x("Firebase.authWithOAuthRedirect", 2, 3, arguments.length);
        mg("Firebase.authWithOAuthRedirect", a);
        A("Firebase.authWithOAuthRedirect", 2, b, !1);
        ng("Firebase.authWithOAuthRedirect", 3, c, !0);
        var d = this.k.M;
        ah(d);
        var e = [Kg],
            f = vg(c);
        "anonymous" === a || "firebase" === a ? P(b, Mg("TRANSPORT_UNAVAILABLE")) : (yc.set("redirect_client_options", f.od), bh(d, e, "/auth/" + a, f, b));
      };
      U.prototype.authWithOAuthRedirect = U.prototype.ag;
      U.prototype.bg = function(a, b, c, d) {
        x("Firebase.authWithOAuthToken", 3, 4, arguments.length);
        mg("Firebase.authWithOAuthToken", a);
        A("Firebase.authWithOAuthToken", 3, c, !1);
        ng("Firebase.authWithOAuthToken", 4, d, !0);
        p(b) ? (lg("Firebase.authWithOAuthToken", 2, b), $g(this.k.M, a + "/token", {access_token: b}, d, c)) : (ng("Firebase.authWithOAuthToken", 2, b, !1), $g(this.k.M, a + "/token", b, d, c));
      };
      U.prototype.authWithOAuthToken = U.prototype.bg;
      U.prototype.Yf = function(a, b) {
        x("Firebase.authAnonymously", 1, 2, arguments.length);
        A("Firebase.authAnonymously", 1, a, !1);
        ng("Firebase.authAnonymously", 2, b, !0);
        $g(this.k.M, "anonymous", {}, b, a);
      };
      U.prototype.authAnonymously = U.prototype.Yf;
      U.prototype.cg = function(a, b, c) {
        x("Firebase.authWithPassword", 2, 3, arguments.length);
        ng("Firebase.authWithPassword", 1, a, !1);
        og("Firebase.authWithPassword", a, "email");
        og("Firebase.authWithPassword", a, "password");
        A("Firebase.authWithPassword", 2, b, !1);
        ng("Firebase.authWithPassword", 3, c, !0);
        $g(this.k.M, "password", a, c, b);
      };
      U.prototype.authWithPassword = U.prototype.cg;
      U.prototype.se = function(a, b) {
        x("Firebase.createUser", 2, 2, arguments.length);
        ng("Firebase.createUser", 1, a, !1);
        og("Firebase.createUser", a, "email");
        og("Firebase.createUser", a, "password");
        A("Firebase.createUser", 2, b, !1);
        this.k.M.se(a, b);
      };
      U.prototype.createUser = U.prototype.se;
      U.prototype.Te = function(a, b) {
        x("Firebase.removeUser", 2, 2, arguments.length);
        ng("Firebase.removeUser", 1, a, !1);
        og("Firebase.removeUser", a, "email");
        og("Firebase.removeUser", a, "password");
        A("Firebase.removeUser", 2, b, !1);
        this.k.M.Te(a, b);
      };
      U.prototype.removeUser = U.prototype.Te;
      U.prototype.pe = function(a, b) {
        x("Firebase.changePassword", 2, 2, arguments.length);
        ng("Firebase.changePassword", 1, a, !1);
        og("Firebase.changePassword", a, "email");
        og("Firebase.changePassword", a, "oldPassword");
        og("Firebase.changePassword", a, "newPassword");
        A("Firebase.changePassword", 2, b, !1);
        this.k.M.pe(a, b);
      };
      U.prototype.changePassword = U.prototype.pe;
      U.prototype.oe = function(a, b) {
        x("Firebase.changeEmail", 2, 2, arguments.length);
        ng("Firebase.changeEmail", 1, a, !1);
        og("Firebase.changeEmail", a, "oldEmail");
        og("Firebase.changeEmail", a, "newEmail");
        og("Firebase.changeEmail", a, "password");
        A("Firebase.changeEmail", 2, b, !1);
        this.k.M.oe(a, b);
      };
      U.prototype.changeEmail = U.prototype.oe;
      U.prototype.Ve = function(a, b) {
        x("Firebase.resetPassword", 2, 2, arguments.length);
        ng("Firebase.resetPassword", 1, a, !1);
        og("Firebase.resetPassword", a, "email");
        A("Firebase.resetPassword", 2, b, !1);
        this.k.M.Ve(a, b);
      };
      U.prototype.resetPassword = U.prototype.Ve;
    })();
  })();
  return _retrieveGlobal();
});

$__System.registerDynamic("50", ["4f"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = req('4f');
  global.define = __define;
  return module.exports;
});

$__System.register('51', ['50'], function (_export) {
	'use strict';

	return {
		setters: [function (_) {}],
		execute: function () {
			_export('default', function (path) {

				var _base = new Firebase(path);

				return {
					methods: {
						fb_init: function fb_init(callback) {
							var _this = this;

							_base.once('value', function (snapshot) {
								if (callback) {
									callback();
								}
							});
							_base.on("child_added", function (snapshot, prevChildKey) {
								_this.$set(snapshot.key(), snapshot.val());
							});
							_base.on("child_changed", function (snapshot) {
								_this.$set(snapshot.key(), snapshot.val());
							});
							_base.on("child_removed", function (snapshot) {
								_this.$delete(snapshot.key());
							});
						},
						fb_dispose: function fb_dispose() {
							_base.off();
						},
						fb_add: function fb_add(value, callback) {
							return _base.push(value, callback);
						},
						fb_set: function fb_set(value, callback) {
							return _base.set(value, callback);
						},
						fb_remove: function fb_remove(key, callback) {
							_base.child(key).remove(callback);
						}
					}
				};
			});
		}
	};
});
$__System.register("52", [], function (_export) {
	"use strict";

	var icon_map, default_icon;
	return {
		setters: [],
		execute: function () {
			icon_map = {
				"chanceflurries": "icon-snowy",
				"chancerain": "icon-showers",
				"chancesleet": "icon-sleet",
				"chancesnow": "icon-cloud icon-snowy",
				"chancetstorms": "icon-thunder",
				"clear": "icon-sun",
				"cloudy": "icon-cloud",
				"flurries": "icon-windysnowcloud icon-sunny",
				"fog": "icon-mist",
				"hazy": "icon-mist",
				"mostlycloudy": "icon-cloudy",
				"mostlysunny": "icon-sun icon-cloudy",
				"partlycloudy": "icon-cloud",
				"partlysunny": "icon-sunny",
				"sleet": "icon-cloud icon-snowy",
				"rain": "icon-cloud icon-rainy",
				"snow": "icon-cloud icon-snowy",
				"sunny": "icon-sun",
				"tstorms": "icon-thunder"
			};
			default_icon = icon_map["clear"];

			_export("default", function (icon) {
				return icon_map[icon] || default_icon;
			});
		}
	};
});
$__System.register('53', ['50', '51', '52', '4d', '4e', '4c'], function (_export) {
  'use strict';

  var Firebase, firebase_mixin, icon_map, tmpl, Vue;
  return {
    setters: [function (_) {
      Firebase = _['default'];
    }, function (_2) {
      firebase_mixin = _2['default'];
    }, function (_3) {
      icon_map = _3['default'];
    }, function (_d) {}, function (_e) {
      tmpl = _e['default'];
    }, function (_c) {
      Vue = _c['default'];
    }],
    execute: function () {

      Vue.component('weather-panel', {
        template: tmpl,
        props: ["base"],
        data: function data() {
          return {
            weather_list: [],
            weather_item: null
          };
        },
        methods: {
          open: function open(item) {
            if (this.weather_item) {
              this.weather_item.fb_dispose();
            }
            var path = this.base + "/" + item.uid;
            this.weather_item = new Vue({
              data: {
                location: null,
                icon: null,
                temperature: null,
                raw: null
              },
              computed: {
                title: function title() {
                  if (this.location) {
                    return this.location;
                  }
                },
                icon_class: function icon_class() {
                  if (this.icon) {
                    return icon_map(this.icon);
                  }
                  return icon_map('default');
                }
              },
              mixins: [firebase_mixin(path)]
            });
            this.weather_item.fb_init();
          },
          get_weather: function get_weather(uid) {
            return this.weather_list.find(function (o) {
              return o.uid == uid;
            });
          }
        },
        ready: function ready() {
          var _this = this;

          var fb = new Firebase(this.base);
          fb.on('value', function (value) {});
          fb.on("child_added", function (value) {
            var node = _this.get_weather(value.key());
            if (!node) {
              _this.weather_list.push({ uid: value.key(), val: value.val() });
            }
          });
          fb.on("child_changed", function (value) {
            var node = _this.get_weather(value.key());
            if (node) {
              node.val = value.val();
            }
          });
          fb.on("child_removed", function (value) {
            var uid = value.key();
            if (_this.weather_item && _this.weather_item.uid == uid) {
              _this.weather_item = null;
            }
            _this.weather_list.some(function (o, i) {
              if (o.uid == uid) {
                _this.weather_list.splice(i, 1);
                return true;
              }
            });
          });
        }
      });
    }
  };
});
$__System.register("54", [], function() { return { setters: [], execute: function() {} } });

$__System.registerDynamic("55", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = "<form @submit.prevent=\"add\">\n  <div class=\"row\">\n    <div class=\"five columns\">\n      <label for=\"lat-input\">lat</label>\n      <input class=\"u-full-width\" type=\"text\" v-model=\"lat\" placeholder=\"\" id=\"lat-input\">\n    </div>\n    <div class=\"five columns\">\n      <label for=\"lng-input\">lat</label>\n      <input class=\"u-full-width\" type=\"text\" v-model=\"lng\" placeholder=\"\" id=\"lng-input\">\n    </div>\n    <div class=\"two columns\">\n      <label>&nbsp;</label>\n      <input class=\"button-primary\" type=\"submit\" value=\"Submit\">\n    </div>\n  </div>\n</form>";
  global.define = __define;
  return module.exports;
});

$__System.register('56', ['51', '54', '55', '4c'], function (_export) {
  'use strict';

  var firebase_mixin, tmpl, Vue;
  return {
    setters: [function (_3) {
      firebase_mixin = _3['default'];
    }, function (_) {}, function (_2) {
      tmpl = _2['default'];
    }, function (_c) {
      Vue = _c['default'];
    }],
    execute: function () {

      Vue.component('work-panel', {
        template: tmpl,
        data: function data() {
          return {
            lat: 51.01,
            lng: 0.3
          };
        },
        props: ["base"],
        methods: {
          add: function add() {
            var fb = firebase_mixin(this.base);
            var id = fb.methods.fb_add({
              lat: parseFloat(this.lat),
              lng: parseFloat(this.lng)
            });
            this.lat = null;
            this.lng = null;
          }
        }
      });
    }
  };
});
$__System.register("57", [], function() { return { setters: [], execute: function() {} } });

$__System.register("58", [], function() { return { setters: [], execute: function() {} } });

$__System.registerDynamic("59", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = "<div class=\"PhotoPanel\">\n    <form action=\"/upload\"\n      class=\"dropzone\"\n      id=\"my-awesome-dropzone\"></form>\n  \t<ul>\n  \t\t<li v-for=\"photo in sorted_photos\">\n  \t\t\t<div class=\"photo-item\">\n                <img :src=\"photo.val.path\" />\n  \t\t\t\t<span>{{ photo.date.format('llll') }} - {{ photo.val.lat }}:{{ photo.val.lng }}</span><br/>\n                <span>{{ photo.uid }}</span><br/>\n                <span>{{ photo.val.path }}</span>\n  \t\t\t</div>\n  \t\t</li>\n  \t</ul>\n</div>\n";
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5a", ["e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    (function() {
      var Dropzone,
          Emitter,
          camelize,
          contentLoaded,
          detectVerticalSquash,
          drawImageIOSFix,
          noop,
          without,
          __slice = [].slice,
          __hasProp = {}.hasOwnProperty,
          __extends = function(child, parent) {
            for (var key in parent) {
              if (__hasProp.call(parent, key))
                child[key] = parent[key];
            }
            function ctor() {
              this.constructor = child;
            }
            ctor.prototype = parent.prototype;
            child.prototype = new ctor();
            child.__super__ = parent.prototype;
            return child;
          };
      noop = function() {};
      Emitter = (function() {
        function Emitter() {}
        Emitter.prototype.addEventListener = Emitter.prototype.on;
        Emitter.prototype.on = function(event, fn) {
          this._callbacks = this._callbacks || {};
          if (!this._callbacks[event]) {
            this._callbacks[event] = [];
          }
          this._callbacks[event].push(fn);
          return this;
        };
        Emitter.prototype.emit = function() {
          var args,
              callback,
              callbacks,
              event,
              _i,
              _len;
          event = arguments[0], args = 2 <= arguments.length ? __slice.call(arguments, 1) : [];
          this._callbacks = this._callbacks || {};
          callbacks = this._callbacks[event];
          if (callbacks) {
            for (_i = 0, _len = callbacks.length; _i < _len; _i++) {
              callback = callbacks[_i];
              callback.apply(this, args);
            }
          }
          return this;
        };
        Emitter.prototype.removeListener = Emitter.prototype.off;
        Emitter.prototype.removeAllListeners = Emitter.prototype.off;
        Emitter.prototype.removeEventListener = Emitter.prototype.off;
        Emitter.prototype.off = function(event, fn) {
          var callback,
              callbacks,
              i,
              _i,
              _len;
          if (!this._callbacks || arguments.length === 0) {
            this._callbacks = {};
            return this;
          }
          callbacks = this._callbacks[event];
          if (!callbacks) {
            return this;
          }
          if (arguments.length === 1) {
            delete this._callbacks[event];
            return this;
          }
          for (i = _i = 0, _len = callbacks.length; _i < _len; i = ++_i) {
            callback = callbacks[i];
            if (callback === fn) {
              callbacks.splice(i, 1);
              break;
            }
          }
          return this;
        };
        return Emitter;
      })();
      Dropzone = (function(_super) {
        var extend,
            resolveOption;
        __extends(Dropzone, _super);
        Dropzone.prototype.Emitter = Emitter;
        Dropzone.prototype.events = ["drop", "dragstart", "dragend", "dragenter", "dragover", "dragleave", "addedfile", "addedfiles", "removedfile", "thumbnail", "error", "errormultiple", "processing", "processingmultiple", "uploadprogress", "totaluploadprogress", "sending", "sendingmultiple", "success", "successmultiple", "canceled", "canceledmultiple", "complete", "completemultiple", "reset", "maxfilesexceeded", "maxfilesreached", "queuecomplete"];
        Dropzone.prototype.defaultOptions = {
          url: null,
          method: "post",
          withCredentials: false,
          parallelUploads: 2,
          uploadMultiple: false,
          maxFilesize: 256,
          paramName: "file",
          createImageThumbnails: true,
          maxThumbnailFilesize: 10,
          thumbnailWidth: 120,
          thumbnailHeight: 120,
          filesizeBase: 1000,
          maxFiles: null,
          params: {},
          clickable: true,
          ignoreHiddenFiles: true,
          acceptedFiles: null,
          acceptedMimeTypes: null,
          autoProcessQueue: true,
          autoQueue: true,
          addRemoveLinks: false,
          previewsContainer: null,
          hiddenInputContainer: "body",
          capture: null,
          dictDefaultMessage: "Drop files here to upload",
          dictFallbackMessage: "Your browser does not support drag'n'drop file uploads.",
          dictFallbackText: "Please use the fallback form below to upload your files like in the olden days.",
          dictFileTooBig: "File is too big ({{filesize}}MiB). Max filesize: {{maxFilesize}}MiB.",
          dictInvalidFileType: "You can't upload files of this type.",
          dictResponseError: "Server responded with {{statusCode}} code.",
          dictCancelUpload: "Cancel upload",
          dictCancelUploadConfirmation: "Are you sure you want to cancel this upload?",
          dictRemoveFile: "Remove file",
          dictRemoveFileConfirmation: null,
          dictMaxFilesExceeded: "You can not upload any more files.",
          accept: function(file, done) {
            return done();
          },
          init: function() {
            return noop;
          },
          forceFallback: false,
          fallback: function() {
            var child,
                messageElement,
                span,
                _i,
                _len,
                _ref;
            this.element.className = "" + this.element.className + " dz-browser-not-supported";
            _ref = this.element.getElementsByTagName("div");
            for (_i = 0, _len = _ref.length; _i < _len; _i++) {
              child = _ref[_i];
              if (/(^| )dz-message($| )/.test(child.className)) {
                messageElement = child;
                child.className = "dz-message";
                continue;
              }
            }
            if (!messageElement) {
              messageElement = Dropzone.createElement("<div class=\"dz-message\"><span></span></div>");
              this.element.appendChild(messageElement);
            }
            span = messageElement.getElementsByTagName("span")[0];
            if (span) {
              if (span.textContent != null) {
                span.textContent = this.options.dictFallbackMessage;
              } else if (span.innerText != null) {
                span.innerText = this.options.dictFallbackMessage;
              }
            }
            return this.element.appendChild(this.getFallbackForm());
          },
          resize: function(file) {
            var info,
                srcRatio,
                trgRatio;
            info = {
              srcX: 0,
              srcY: 0,
              srcWidth: file.width,
              srcHeight: file.height
            };
            srcRatio = file.width / file.height;
            info.optWidth = this.options.thumbnailWidth;
            info.optHeight = this.options.thumbnailHeight;
            if ((info.optWidth == null) && (info.optHeight == null)) {
              info.optWidth = info.srcWidth;
              info.optHeight = info.srcHeight;
            } else if (info.optWidth == null) {
              info.optWidth = srcRatio * info.optHeight;
            } else if (info.optHeight == null) {
              info.optHeight = (1 / srcRatio) * info.optWidth;
            }
            trgRatio = info.optWidth / info.optHeight;
            if (file.height < info.optHeight || file.width < info.optWidth) {
              info.trgHeight = info.srcHeight;
              info.trgWidth = info.srcWidth;
            } else {
              if (srcRatio > trgRatio) {
                info.srcHeight = file.height;
                info.srcWidth = info.srcHeight * trgRatio;
              } else {
                info.srcWidth = file.width;
                info.srcHeight = info.srcWidth / trgRatio;
              }
            }
            info.srcX = (file.width - info.srcWidth) / 2;
            info.srcY = (file.height - info.srcHeight) / 2;
            return info;
          },
          drop: function(e) {
            return this.element.classList.remove("dz-drag-hover");
          },
          dragstart: noop,
          dragend: function(e) {
            return this.element.classList.remove("dz-drag-hover");
          },
          dragenter: function(e) {
            return this.element.classList.add("dz-drag-hover");
          },
          dragover: function(e) {
            return this.element.classList.add("dz-drag-hover");
          },
          dragleave: function(e) {
            return this.element.classList.remove("dz-drag-hover");
          },
          paste: noop,
          reset: function() {
            return this.element.classList.remove("dz-started");
          },
          addedfile: function(file) {
            var node,
                removeFileEvent,
                removeLink,
                _i,
                _j,
                _k,
                _len,
                _len1,
                _len2,
                _ref,
                _ref1,
                _ref2,
                _results;
            if (this.element === this.previewsContainer) {
              this.element.classList.add("dz-started");
            }
            if (this.previewsContainer) {
              file.previewElement = Dropzone.createElement(this.options.previewTemplate.trim());
              file.previewTemplate = file.previewElement;
              this.previewsContainer.appendChild(file.previewElement);
              _ref = file.previewElement.querySelectorAll("[data-dz-name]");
              for (_i = 0, _len = _ref.length; _i < _len; _i++) {
                node = _ref[_i];
                node.textContent = file.name;
              }
              _ref1 = file.previewElement.querySelectorAll("[data-dz-size]");
              for (_j = 0, _len1 = _ref1.length; _j < _len1; _j++) {
                node = _ref1[_j];
                node.innerHTML = this.filesize(file.size);
              }
              if (this.options.addRemoveLinks) {
                file._removeLink = Dropzone.createElement("<a class=\"dz-remove\" href=\"javascript:undefined;\" data-dz-remove>" + this.options.dictRemoveFile + "</a>");
                file.previewElement.appendChild(file._removeLink);
              }
              removeFileEvent = (function(_this) {
                return function(e) {
                  e.preventDefault();
                  e.stopPropagation();
                  if (file.status === Dropzone.UPLOADING) {
                    return Dropzone.confirm(_this.options.dictCancelUploadConfirmation, function() {
                      return _this.removeFile(file);
                    });
                  } else {
                    if (_this.options.dictRemoveFileConfirmation) {
                      return Dropzone.confirm(_this.options.dictRemoveFileConfirmation, function() {
                        return _this.removeFile(file);
                      });
                    } else {
                      return _this.removeFile(file);
                    }
                  }
                };
              })(this);
              _ref2 = file.previewElement.querySelectorAll("[data-dz-remove]");
              _results = [];
              for (_k = 0, _len2 = _ref2.length; _k < _len2; _k++) {
                removeLink = _ref2[_k];
                _results.push(removeLink.addEventListener("click", removeFileEvent));
              }
              return _results;
            }
          },
          removedfile: function(file) {
            var _ref;
            if (file.previewElement) {
              if ((_ref = file.previewElement) != null) {
                _ref.parentNode.removeChild(file.previewElement);
              }
            }
            return this._updateMaxFilesReachedClass();
          },
          thumbnail: function(file, dataUrl) {
            var thumbnailElement,
                _i,
                _len,
                _ref;
            if (file.previewElement) {
              file.previewElement.classList.remove("dz-file-preview");
              _ref = file.previewElement.querySelectorAll("[data-dz-thumbnail]");
              for (_i = 0, _len = _ref.length; _i < _len; _i++) {
                thumbnailElement = _ref[_i];
                thumbnailElement.alt = file.name;
                thumbnailElement.src = dataUrl;
              }
              return setTimeout(((function(_this) {
                return function() {
                  return file.previewElement.classList.add("dz-image-preview");
                };
              })(this)), 1);
            }
          },
          error: function(file, message) {
            var node,
                _i,
                _len,
                _ref,
                _results;
            if (file.previewElement) {
              file.previewElement.classList.add("dz-error");
              if (typeof message !== "String" && message.error) {
                message = message.error;
              }
              _ref = file.previewElement.querySelectorAll("[data-dz-errormessage]");
              _results = [];
              for (_i = 0, _len = _ref.length; _i < _len; _i++) {
                node = _ref[_i];
                _results.push(node.textContent = message);
              }
              return _results;
            }
          },
          errormultiple: noop,
          processing: function(file) {
            if (file.previewElement) {
              file.previewElement.classList.add("dz-processing");
              if (file._removeLink) {
                return file._removeLink.textContent = this.options.dictCancelUpload;
              }
            }
          },
          processingmultiple: noop,
          uploadprogress: function(file, progress, bytesSent) {
            var node,
                _i,
                _len,
                _ref,
                _results;
            if (file.previewElement) {
              _ref = file.previewElement.querySelectorAll("[data-dz-uploadprogress]");
              _results = [];
              for (_i = 0, _len = _ref.length; _i < _len; _i++) {
                node = _ref[_i];
                if (node.nodeName === 'PROGRESS') {
                  _results.push(node.value = progress);
                } else {
                  _results.push(node.style.width = "" + progress + "%");
                }
              }
              return _results;
            }
          },
          totaluploadprogress: noop,
          sending: noop,
          sendingmultiple: noop,
          success: function(file) {
            if (file.previewElement) {
              return file.previewElement.classList.add("dz-success");
            }
          },
          successmultiple: noop,
          canceled: function(file) {
            return this.emit("error", file, "Upload canceled.");
          },
          canceledmultiple: noop,
          complete: function(file) {
            if (file._removeLink) {
              file._removeLink.textContent = this.options.dictRemoveFile;
            }
            if (file.previewElement) {
              return file.previewElement.classList.add("dz-complete");
            }
          },
          completemultiple: noop,
          maxfilesexceeded: noop,
          maxfilesreached: noop,
          queuecomplete: noop,
          addedfiles: noop,
          previewTemplate: "<div class=\"dz-preview dz-file-preview\">\n  <div class=\"dz-image\"><img data-dz-thumbnail /></div>\n  <div class=\"dz-details\">\n    <div class=\"dz-size\"><span data-dz-size></span></div>\n    <div class=\"dz-filename\"><span data-dz-name></span></div>\n  </div>\n  <div class=\"dz-progress\"><span class=\"dz-upload\" data-dz-uploadprogress></span></div>\n  <div class=\"dz-error-message\"><span data-dz-errormessage></span></div>\n  <div class=\"dz-success-mark\">\n    <svg width=\"54px\" height=\"54px\" viewBox=\"0 0 54 54\" version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" xmlns:sketch=\"http://www.bohemiancoding.com/sketch/ns\">\n      <title>Check</title>\n      <defs></defs>\n      <g id=\"Page-1\" stroke=\"none\" stroke-width=\"1\" fill=\"none\" fill-rule=\"evenodd\" sketch:type=\"MSPage\">\n        <path d=\"M23.5,31.8431458 L17.5852419,25.9283877 C16.0248253,24.3679711 13.4910294,24.366835 11.9289322,25.9289322 C10.3700136,27.4878508 10.3665912,30.0234455 11.9283877,31.5852419 L20.4147581,40.0716123 C20.5133999,40.1702541 20.6159315,40.2626649 20.7218615,40.3488435 C22.2835669,41.8725651 24.794234,41.8626202 26.3461564,40.3106978 L43.3106978,23.3461564 C44.8771021,21.7797521 44.8758057,19.2483887 43.3137085,17.6862915 C41.7547899,16.1273729 39.2176035,16.1255422 37.6538436,17.6893022 L23.5,31.8431458 Z M27,53 C41.3594035,53 53,41.3594035 53,27 C53,12.6405965 41.3594035,1 27,1 C12.6405965,1 1,12.6405965 1,27 C1,41.3594035 12.6405965,53 27,53 Z\" id=\"Oval-2\" stroke-opacity=\"0.198794158\" stroke=\"#747474\" fill-opacity=\"0.816519475\" fill=\"#FFFFFF\" sketch:type=\"MSShapeGroup\"></path>\n      </g>\n    </svg>\n  </div>\n  <div class=\"dz-error-mark\">\n    <svg width=\"54px\" height=\"54px\" viewBox=\"0 0 54 54\" version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" xmlns:sketch=\"http://www.bohemiancoding.com/sketch/ns\">\n      <title>Error</title>\n      <defs></defs>\n      <g id=\"Page-1\" stroke=\"none\" stroke-width=\"1\" fill=\"none\" fill-rule=\"evenodd\" sketch:type=\"MSPage\">\n        <g id=\"Check-+-Oval-2\" sketch:type=\"MSLayerGroup\" stroke=\"#747474\" stroke-opacity=\"0.198794158\" fill=\"#FFFFFF\" fill-opacity=\"0.816519475\">\n          <path d=\"M32.6568542,29 L38.3106978,23.3461564 C39.8771021,21.7797521 39.8758057,19.2483887 38.3137085,17.6862915 C36.7547899,16.1273729 34.2176035,16.1255422 32.6538436,17.6893022 L27,23.3431458 L21.3461564,17.6893022 C19.7823965,16.1255422 17.2452101,16.1273729 15.6862915,17.6862915 C14.1241943,19.2483887 14.1228979,21.7797521 15.6893022,23.3461564 L21.3431458,29 L15.6893022,34.6538436 C14.1228979,36.2202479 14.1241943,38.7516113 15.6862915,40.3137085 C17.2452101,41.8726271 19.7823965,41.8744578 21.3461564,40.3106978 L27,34.6568542 L32.6538436,40.3106978 C34.2176035,41.8744578 36.7547899,41.8726271 38.3137085,40.3137085 C39.8758057,38.7516113 39.8771021,36.2202479 38.3106978,34.6538436 L32.6568542,29 Z M27,53 C41.3594035,53 53,41.3594035 53,27 C53,12.6405965 41.3594035,1 27,1 C12.6405965,1 1,12.6405965 1,27 C1,41.3594035 12.6405965,53 27,53 Z\" id=\"Oval-2\" sketch:type=\"MSShapeGroup\"></path>\n        </g>\n      </g>\n    </svg>\n  </div>\n</div>"
        };
        extend = function() {
          var key,
              object,
              objects,
              target,
              val,
              _i,
              _len;
          target = arguments[0], objects = 2 <= arguments.length ? __slice.call(arguments, 1) : [];
          for (_i = 0, _len = objects.length; _i < _len; _i++) {
            object = objects[_i];
            for (key in object) {
              val = object[key];
              target[key] = val;
            }
          }
          return target;
        };
        function Dropzone(element, options) {
          var elementOptions,
              fallback,
              _ref;
          this.element = element;
          this.version = Dropzone.version;
          this.defaultOptions.previewTemplate = this.defaultOptions.previewTemplate.replace(/\n*/g, "");
          this.clickableElements = [];
          this.listeners = [];
          this.files = [];
          if (typeof this.element === "string") {
            this.element = document.querySelector(this.element);
          }
          if (!(this.element && (this.element.nodeType != null))) {
            throw new Error("Invalid dropzone element.");
          }
          if (this.element.dropzone) {
            throw new Error("Dropzone already attached.");
          }
          Dropzone.instances.push(this);
          this.element.dropzone = this;
          elementOptions = (_ref = Dropzone.optionsForElement(this.element)) != null ? _ref : {};
          this.options = extend({}, this.defaultOptions, elementOptions, options != null ? options : {});
          if (this.options.forceFallback || !Dropzone.isBrowserSupported()) {
            return this.options.fallback.call(this);
          }
          if (this.options.url == null) {
            this.options.url = this.element.getAttribute("action");
          }
          if (!this.options.url) {
            throw new Error("No URL provided.");
          }
          if (this.options.acceptedFiles && this.options.acceptedMimeTypes) {
            throw new Error("You can't provide both 'acceptedFiles' and 'acceptedMimeTypes'. 'acceptedMimeTypes' is deprecated.");
          }
          if (this.options.acceptedMimeTypes) {
            this.options.acceptedFiles = this.options.acceptedMimeTypes;
            delete this.options.acceptedMimeTypes;
          }
          this.options.method = this.options.method.toUpperCase();
          if ((fallback = this.getExistingFallback()) && fallback.parentNode) {
            fallback.parentNode.removeChild(fallback);
          }
          if (this.options.previewsContainer !== false) {
            if (this.options.previewsContainer) {
              this.previewsContainer = Dropzone.getElement(this.options.previewsContainer, "previewsContainer");
            } else {
              this.previewsContainer = this.element;
            }
          }
          if (this.options.clickable) {
            if (this.options.clickable === true) {
              this.clickableElements = [this.element];
            } else {
              this.clickableElements = Dropzone.getElements(this.options.clickable, "clickable");
            }
          }
          this.init();
        }
        Dropzone.prototype.getAcceptedFiles = function() {
          var file,
              _i,
              _len,
              _ref,
              _results;
          _ref = this.files;
          _results = [];
          for (_i = 0, _len = _ref.length; _i < _len; _i++) {
            file = _ref[_i];
            if (file.accepted) {
              _results.push(file);
            }
          }
          return _results;
        };
        Dropzone.prototype.getRejectedFiles = function() {
          var file,
              _i,
              _len,
              _ref,
              _results;
          _ref = this.files;
          _results = [];
          for (_i = 0, _len = _ref.length; _i < _len; _i++) {
            file = _ref[_i];
            if (!file.accepted) {
              _results.push(file);
            }
          }
          return _results;
        };
        Dropzone.prototype.getFilesWithStatus = function(status) {
          var file,
              _i,
              _len,
              _ref,
              _results;
          _ref = this.files;
          _results = [];
          for (_i = 0, _len = _ref.length; _i < _len; _i++) {
            file = _ref[_i];
            if (file.status === status) {
              _results.push(file);
            }
          }
          return _results;
        };
        Dropzone.prototype.getQueuedFiles = function() {
          return this.getFilesWithStatus(Dropzone.QUEUED);
        };
        Dropzone.prototype.getUploadingFiles = function() {
          return this.getFilesWithStatus(Dropzone.UPLOADING);
        };
        Dropzone.prototype.getAddedFiles = function() {
          return this.getFilesWithStatus(Dropzone.ADDED);
        };
        Dropzone.prototype.getActiveFiles = function() {
          var file,
              _i,
              _len,
              _ref,
              _results;
          _ref = this.files;
          _results = [];
          for (_i = 0, _len = _ref.length; _i < _len; _i++) {
            file = _ref[_i];
            if (file.status === Dropzone.UPLOADING || file.status === Dropzone.QUEUED) {
              _results.push(file);
            }
          }
          return _results;
        };
        Dropzone.prototype.init = function() {
          var eventName,
              noPropagation,
              setupHiddenFileInput,
              _i,
              _len,
              _ref,
              _ref1;
          if (this.element.tagName === "form") {
            this.element.setAttribute("enctype", "multipart/form-data");
          }
          if (this.element.classList.contains("dropzone") && !this.element.querySelector(".dz-message")) {
            this.element.appendChild(Dropzone.createElement("<div class=\"dz-default dz-message\"><span>" + this.options.dictDefaultMessage + "</span></div>"));
          }
          if (this.clickableElements.length) {
            setupHiddenFileInput = (function(_this) {
              return function() {
                if (_this.hiddenFileInput) {
                  _this.hiddenFileInput.parentNode.removeChild(_this.hiddenFileInput);
                }
                _this.hiddenFileInput = document.createElement("input");
                _this.hiddenFileInput.setAttribute("type", "file");
                if ((_this.options.maxFiles == null) || _this.options.maxFiles > 1) {
                  _this.hiddenFileInput.setAttribute("multiple", "multiple");
                }
                _this.hiddenFileInput.className = "dz-hidden-input";
                if (_this.options.acceptedFiles != null) {
                  _this.hiddenFileInput.setAttribute("accept", _this.options.acceptedFiles);
                }
                if (_this.options.capture != null) {
                  _this.hiddenFileInput.setAttribute("capture", _this.options.capture);
                }
                _this.hiddenFileInput.style.visibility = "hidden";
                _this.hiddenFileInput.style.position = "absolute";
                _this.hiddenFileInput.style.top = "0";
                _this.hiddenFileInput.style.left = "0";
                _this.hiddenFileInput.style.height = "0";
                _this.hiddenFileInput.style.width = "0";
                document.querySelector(_this.options.hiddenInputContainer).appendChild(_this.hiddenFileInput);
                return _this.hiddenFileInput.addEventListener("change", function() {
                  var file,
                      files,
                      _i,
                      _len;
                  files = _this.hiddenFileInput.files;
                  if (files.length) {
                    for (_i = 0, _len = files.length; _i < _len; _i++) {
                      file = files[_i];
                      _this.addFile(file);
                    }
                  }
                  _this.emit("addedfiles", files);
                  return setupHiddenFileInput();
                });
              };
            })(this);
            setupHiddenFileInput();
          }
          this.URL = (_ref = window.URL) != null ? _ref : window.webkitURL;
          _ref1 = this.events;
          for (_i = 0, _len = _ref1.length; _i < _len; _i++) {
            eventName = _ref1[_i];
            this.on(eventName, this.options[eventName]);
          }
          this.on("uploadprogress", (function(_this) {
            return function() {
              return _this.updateTotalUploadProgress();
            };
          })(this));
          this.on("removedfile", (function(_this) {
            return function() {
              return _this.updateTotalUploadProgress();
            };
          })(this));
          this.on("canceled", (function(_this) {
            return function(file) {
              return _this.emit("complete", file);
            };
          })(this));
          this.on("complete", (function(_this) {
            return function(file) {
              if (_this.getAddedFiles().length === 0 && _this.getUploadingFiles().length === 0 && _this.getQueuedFiles().length === 0) {
                return setTimeout((function() {
                  return _this.emit("queuecomplete");
                }), 0);
              }
            };
          })(this));
          noPropagation = function(e) {
            e.stopPropagation();
            if (e.preventDefault) {
              return e.preventDefault();
            } else {
              return e.returnValue = false;
            }
          };
          this.listeners = [{
            element: this.element,
            events: {
              "dragstart": (function(_this) {
                return function(e) {
                  return _this.emit("dragstart", e);
                };
              })(this),
              "dragenter": (function(_this) {
                return function(e) {
                  noPropagation(e);
                  return _this.emit("dragenter", e);
                };
              })(this),
              "dragover": (function(_this) {
                return function(e) {
                  var efct;
                  try {
                    efct = e.dataTransfer.effectAllowed;
                  } catch (_error) {}
                  e.dataTransfer.dropEffect = 'move' === efct || 'linkMove' === efct ? 'move' : 'copy';
                  noPropagation(e);
                  return _this.emit("dragover", e);
                };
              })(this),
              "dragleave": (function(_this) {
                return function(e) {
                  return _this.emit("dragleave", e);
                };
              })(this),
              "drop": (function(_this) {
                return function(e) {
                  noPropagation(e);
                  return _this.drop(e);
                };
              })(this),
              "dragend": (function(_this) {
                return function(e) {
                  return _this.emit("dragend", e);
                };
              })(this)
            }
          }];
          this.clickableElements.forEach((function(_this) {
            return function(clickableElement) {
              return _this.listeners.push({
                element: clickableElement,
                events: {"click": function(evt) {
                    if ((clickableElement !== _this.element) || (evt.target === _this.element || Dropzone.elementInside(evt.target, _this.element.querySelector(".dz-message")))) {
                      _this.hiddenFileInput.click();
                    }
                    return true;
                  }}
              });
            };
          })(this));
          this.enable();
          return this.options.init.call(this);
        };
        Dropzone.prototype.destroy = function() {
          var _ref;
          this.disable();
          this.removeAllFiles(true);
          if ((_ref = this.hiddenFileInput) != null ? _ref.parentNode : void 0) {
            this.hiddenFileInput.parentNode.removeChild(this.hiddenFileInput);
            this.hiddenFileInput = null;
          }
          delete this.element.dropzone;
          return Dropzone.instances.splice(Dropzone.instances.indexOf(this), 1);
        };
        Dropzone.prototype.updateTotalUploadProgress = function() {
          var activeFiles,
              file,
              totalBytes,
              totalBytesSent,
              totalUploadProgress,
              _i,
              _len,
              _ref;
          totalBytesSent = 0;
          totalBytes = 0;
          activeFiles = this.getActiveFiles();
          if (activeFiles.length) {
            _ref = this.getActiveFiles();
            for (_i = 0, _len = _ref.length; _i < _len; _i++) {
              file = _ref[_i];
              totalBytesSent += file.upload.bytesSent;
              totalBytes += file.upload.total;
            }
            totalUploadProgress = 100 * totalBytesSent / totalBytes;
          } else {
            totalUploadProgress = 100;
          }
          return this.emit("totaluploadprogress", totalUploadProgress, totalBytes, totalBytesSent);
        };
        Dropzone.prototype._getParamName = function(n) {
          if (typeof this.options.paramName === "function") {
            return this.options.paramName(n);
          } else {
            return "" + this.options.paramName + (this.options.uploadMultiple ? "[" + n + "]" : "");
          }
        };
        Dropzone.prototype.getFallbackForm = function() {
          var existingFallback,
              fields,
              fieldsString,
              form;
          if (existingFallback = this.getExistingFallback()) {
            return existingFallback;
          }
          fieldsString = "<div class=\"dz-fallback\">";
          if (this.options.dictFallbackText) {
            fieldsString += "<p>" + this.options.dictFallbackText + "</p>";
          }
          fieldsString += "<input type=\"file\" name=\"" + (this._getParamName(0)) + "\" " + (this.options.uploadMultiple ? 'multiple="multiple"' : void 0) + " /><input type=\"submit\" value=\"Upload!\"></div>";
          fields = Dropzone.createElement(fieldsString);
          if (this.element.tagName !== "FORM") {
            form = Dropzone.createElement("<form action=\"" + this.options.url + "\" enctype=\"multipart/form-data\" method=\"" + this.options.method + "\"></form>");
            form.appendChild(fields);
          } else {
            this.element.setAttribute("enctype", "multipart/form-data");
            this.element.setAttribute("method", this.options.method);
          }
          return form != null ? form : fields;
        };
        Dropzone.prototype.getExistingFallback = function() {
          var fallback,
              getFallback,
              tagName,
              _i,
              _len,
              _ref;
          getFallback = function(elements) {
            var el,
                _i,
                _len;
            for (_i = 0, _len = elements.length; _i < _len; _i++) {
              el = elements[_i];
              if (/(^| )fallback($| )/.test(el.className)) {
                return el;
              }
            }
          };
          _ref = ["div", "form"];
          for (_i = 0, _len = _ref.length; _i < _len; _i++) {
            tagName = _ref[_i];
            if (fallback = getFallback(this.element.getElementsByTagName(tagName))) {
              return fallback;
            }
          }
        };
        Dropzone.prototype.setupEventListeners = function() {
          var elementListeners,
              event,
              listener,
              _i,
              _len,
              _ref,
              _results;
          _ref = this.listeners;
          _results = [];
          for (_i = 0, _len = _ref.length; _i < _len; _i++) {
            elementListeners = _ref[_i];
            _results.push((function() {
              var _ref1,
                  _results1;
              _ref1 = elementListeners.events;
              _results1 = [];
              for (event in _ref1) {
                listener = _ref1[event];
                _results1.push(elementListeners.element.addEventListener(event, listener, false));
              }
              return _results1;
            })());
          }
          return _results;
        };
        Dropzone.prototype.removeEventListeners = function() {
          var elementListeners,
              event,
              listener,
              _i,
              _len,
              _ref,
              _results;
          _ref = this.listeners;
          _results = [];
          for (_i = 0, _len = _ref.length; _i < _len; _i++) {
            elementListeners = _ref[_i];
            _results.push((function() {
              var _ref1,
                  _results1;
              _ref1 = elementListeners.events;
              _results1 = [];
              for (event in _ref1) {
                listener = _ref1[event];
                _results1.push(elementListeners.element.removeEventListener(event, listener, false));
              }
              return _results1;
            })());
          }
          return _results;
        };
        Dropzone.prototype.disable = function() {
          var file,
              _i,
              _len,
              _ref,
              _results;
          this.clickableElements.forEach(function(element) {
            return element.classList.remove("dz-clickable");
          });
          this.removeEventListeners();
          _ref = this.files;
          _results = [];
          for (_i = 0, _len = _ref.length; _i < _len; _i++) {
            file = _ref[_i];
            _results.push(this.cancelUpload(file));
          }
          return _results;
        };
        Dropzone.prototype.enable = function() {
          this.clickableElements.forEach(function(element) {
            return element.classList.add("dz-clickable");
          });
          return this.setupEventListeners();
        };
        Dropzone.prototype.filesize = function(size) {
          var cutoff,
              i,
              selectedSize,
              selectedUnit,
              unit,
              units,
              _i,
              _len;
          selectedSize = 0;
          selectedUnit = "b";
          if (size > 0) {
            units = ['TB', 'GB', 'MB', 'KB', 'b'];
            for (i = _i = 0, _len = units.length; _i < _len; i = ++_i) {
              unit = units[i];
              cutoff = Math.pow(this.options.filesizeBase, 4 - i) / 10;
              if (size >= cutoff) {
                selectedSize = size / Math.pow(this.options.filesizeBase, 4 - i);
                selectedUnit = unit;
                break;
              }
            }
            selectedSize = Math.round(10 * selectedSize) / 10;
          }
          return "<strong>" + selectedSize + "</strong> " + selectedUnit;
        };
        Dropzone.prototype._updateMaxFilesReachedClass = function() {
          if ((this.options.maxFiles != null) && this.getAcceptedFiles().length >= this.options.maxFiles) {
            if (this.getAcceptedFiles().length === this.options.maxFiles) {
              this.emit('maxfilesreached', this.files);
            }
            return this.element.classList.add("dz-max-files-reached");
          } else {
            return this.element.classList.remove("dz-max-files-reached");
          }
        };
        Dropzone.prototype.drop = function(e) {
          var files,
              items;
          if (!e.dataTransfer) {
            return;
          }
          this.emit("drop", e);
          files = e.dataTransfer.files;
          this.emit("addedfiles", files);
          if (files.length) {
            items = e.dataTransfer.items;
            if (items && items.length && (items[0].webkitGetAsEntry != null)) {
              this._addFilesFromItems(items);
            } else {
              this.handleFiles(files);
            }
          }
        };
        Dropzone.prototype.paste = function(e) {
          var items,
              _ref;
          if ((e != null ? (_ref = e.clipboardData) != null ? _ref.items : void 0 : void 0) == null) {
            return;
          }
          this.emit("paste", e);
          items = e.clipboardData.items;
          if (items.length) {
            return this._addFilesFromItems(items);
          }
        };
        Dropzone.prototype.handleFiles = function(files) {
          var file,
              _i,
              _len,
              _results;
          _results = [];
          for (_i = 0, _len = files.length; _i < _len; _i++) {
            file = files[_i];
            _results.push(this.addFile(file));
          }
          return _results;
        };
        Dropzone.prototype._addFilesFromItems = function(items) {
          var entry,
              item,
              _i,
              _len,
              _results;
          _results = [];
          for (_i = 0, _len = items.length; _i < _len; _i++) {
            item = items[_i];
            if ((item.webkitGetAsEntry != null) && (entry = item.webkitGetAsEntry())) {
              if (entry.isFile) {
                _results.push(this.addFile(item.getAsFile()));
              } else if (entry.isDirectory) {
                _results.push(this._addFilesFromDirectory(entry, entry.name));
              } else {
                _results.push(void 0);
              }
            } else if (item.getAsFile != null) {
              if ((item.kind == null) || item.kind === "file") {
                _results.push(this.addFile(item.getAsFile()));
              } else {
                _results.push(void 0);
              }
            } else {
              _results.push(void 0);
            }
          }
          return _results;
        };
        Dropzone.prototype._addFilesFromDirectory = function(directory, path) {
          var dirReader,
              entriesReader;
          dirReader = directory.createReader();
          entriesReader = (function(_this) {
            return function(entries) {
              var entry,
                  _i,
                  _len;
              for (_i = 0, _len = entries.length; _i < _len; _i++) {
                entry = entries[_i];
                if (entry.isFile) {
                  entry.file(function(file) {
                    if (_this.options.ignoreHiddenFiles && file.name.substring(0, 1) === '.') {
                      return;
                    }
                    file.fullPath = "" + path + "/" + file.name;
                    return _this.addFile(file);
                  });
                } else if (entry.isDirectory) {
                  _this._addFilesFromDirectory(entry, "" + path + "/" + entry.name);
                }
              }
            };
          })(this);
          return dirReader.readEntries(entriesReader, function(error) {
            return typeof console !== "undefined" && console !== null ? typeof console.log === "function" ? console.log(error) : void 0 : void 0;
          });
        };
        Dropzone.prototype.accept = function(file, done) {
          if (file.size > this.options.maxFilesize * 1024 * 1024) {
            return done(this.options.dictFileTooBig.replace("{{filesize}}", Math.round(file.size / 1024 / 10.24) / 100).replace("{{maxFilesize}}", this.options.maxFilesize));
          } else if (!Dropzone.isValidFile(file, this.options.acceptedFiles)) {
            return done(this.options.dictInvalidFileType);
          } else if ((this.options.maxFiles != null) && this.getAcceptedFiles().length >= this.options.maxFiles) {
            done(this.options.dictMaxFilesExceeded.replace("{{maxFiles}}", this.options.maxFiles));
            return this.emit("maxfilesexceeded", file);
          } else {
            return this.options.accept.call(this, file, done);
          }
        };
        Dropzone.prototype.addFile = function(file) {
          file.upload = {
            progress: 0,
            total: file.size,
            bytesSent: 0
          };
          this.files.push(file);
          file.status = Dropzone.ADDED;
          this.emit("addedfile", file);
          this._enqueueThumbnail(file);
          return this.accept(file, (function(_this) {
            return function(error) {
              if (error) {
                file.accepted = false;
                _this._errorProcessing([file], error);
              } else {
                file.accepted = true;
                if (_this.options.autoQueue) {
                  _this.enqueueFile(file);
                }
              }
              return _this._updateMaxFilesReachedClass();
            };
          })(this));
        };
        Dropzone.prototype.enqueueFiles = function(files) {
          var file,
              _i,
              _len;
          for (_i = 0, _len = files.length; _i < _len; _i++) {
            file = files[_i];
            this.enqueueFile(file);
          }
          return null;
        };
        Dropzone.prototype.enqueueFile = function(file) {
          if (file.status === Dropzone.ADDED && file.accepted === true) {
            file.status = Dropzone.QUEUED;
            if (this.options.autoProcessQueue) {
              return setTimeout(((function(_this) {
                return function() {
                  return _this.processQueue();
                };
              })(this)), 0);
            }
          } else {
            throw new Error("This file can't be queued because it has already been processed or was rejected.");
          }
        };
        Dropzone.prototype._thumbnailQueue = [];
        Dropzone.prototype._processingThumbnail = false;
        Dropzone.prototype._enqueueThumbnail = function(file) {
          if (this.options.createImageThumbnails && file.type.match(/image.*/) && file.size <= this.options.maxThumbnailFilesize * 1024 * 1024) {
            this._thumbnailQueue.push(file);
            return setTimeout(((function(_this) {
              return function() {
                return _this._processThumbnailQueue();
              };
            })(this)), 0);
          }
        };
        Dropzone.prototype._processThumbnailQueue = function() {
          if (this._processingThumbnail || this._thumbnailQueue.length === 0) {
            return;
          }
          this._processingThumbnail = true;
          return this.createThumbnail(this._thumbnailQueue.shift(), (function(_this) {
            return function() {
              _this._processingThumbnail = false;
              return _this._processThumbnailQueue();
            };
          })(this));
        };
        Dropzone.prototype.removeFile = function(file) {
          if (file.status === Dropzone.UPLOADING) {
            this.cancelUpload(file);
          }
          this.files = without(this.files, file);
          this.emit("removedfile", file);
          if (this.files.length === 0) {
            return this.emit("reset");
          }
        };
        Dropzone.prototype.removeAllFiles = function(cancelIfNecessary) {
          var file,
              _i,
              _len,
              _ref;
          if (cancelIfNecessary == null) {
            cancelIfNecessary = false;
          }
          _ref = this.files.slice();
          for (_i = 0, _len = _ref.length; _i < _len; _i++) {
            file = _ref[_i];
            if (file.status !== Dropzone.UPLOADING || cancelIfNecessary) {
              this.removeFile(file);
            }
          }
          return null;
        };
        Dropzone.prototype.createThumbnail = function(file, callback) {
          var fileReader;
          fileReader = new FileReader;
          fileReader.onload = (function(_this) {
            return function() {
              if (file.type === "image/svg+xml") {
                _this.emit("thumbnail", file, fileReader.result);
                if (callback != null) {
                  callback();
                }
                return;
              }
              return _this.createThumbnailFromUrl(file, fileReader.result, callback);
            };
          })(this);
          return fileReader.readAsDataURL(file);
        };
        Dropzone.prototype.createThumbnailFromUrl = function(file, imageUrl, callback, crossOrigin) {
          var img;
          img = document.createElement("img");
          if (crossOrigin) {
            img.crossOrigin = crossOrigin;
          }
          img.onload = (function(_this) {
            return function() {
              var canvas,
                  ctx,
                  resizeInfo,
                  thumbnail,
                  _ref,
                  _ref1,
                  _ref2,
                  _ref3;
              file.width = img.width;
              file.height = img.height;
              resizeInfo = _this.options.resize.call(_this, file);
              if (resizeInfo.trgWidth == null) {
                resizeInfo.trgWidth = resizeInfo.optWidth;
              }
              if (resizeInfo.trgHeight == null) {
                resizeInfo.trgHeight = resizeInfo.optHeight;
              }
              canvas = document.createElement("canvas");
              ctx = canvas.getContext("2d");
              canvas.width = resizeInfo.trgWidth;
              canvas.height = resizeInfo.trgHeight;
              drawImageIOSFix(ctx, img, (_ref = resizeInfo.srcX) != null ? _ref : 0, (_ref1 = resizeInfo.srcY) != null ? _ref1 : 0, resizeInfo.srcWidth, resizeInfo.srcHeight, (_ref2 = resizeInfo.trgX) != null ? _ref2 : 0, (_ref3 = resizeInfo.trgY) != null ? _ref3 : 0, resizeInfo.trgWidth, resizeInfo.trgHeight);
              thumbnail = canvas.toDataURL("image/png");
              _this.emit("thumbnail", file, thumbnail);
              if (callback != null) {
                return callback();
              }
            };
          })(this);
          if (callback != null) {
            img.onerror = callback;
          }
          return img.src = imageUrl;
        };
        Dropzone.prototype.processQueue = function() {
          var i,
              parallelUploads,
              processingLength,
              queuedFiles;
          parallelUploads = this.options.parallelUploads;
          processingLength = this.getUploadingFiles().length;
          i = processingLength;
          if (processingLength >= parallelUploads) {
            return;
          }
          queuedFiles = this.getQueuedFiles();
          if (!(queuedFiles.length > 0)) {
            return;
          }
          if (this.options.uploadMultiple) {
            return this.processFiles(queuedFiles.slice(0, parallelUploads - processingLength));
          } else {
            while (i < parallelUploads) {
              if (!queuedFiles.length) {
                return;
              }
              this.processFile(queuedFiles.shift());
              i++;
            }
          }
        };
        Dropzone.prototype.processFile = function(file) {
          return this.processFiles([file]);
        };
        Dropzone.prototype.processFiles = function(files) {
          var file,
              _i,
              _len;
          for (_i = 0, _len = files.length; _i < _len; _i++) {
            file = files[_i];
            file.processing = true;
            file.status = Dropzone.UPLOADING;
            this.emit("processing", file);
          }
          if (this.options.uploadMultiple) {
            this.emit("processingmultiple", files);
          }
          return this.uploadFiles(files);
        };
        Dropzone.prototype._getFilesWithXhr = function(xhr) {
          var file,
              files;
          return files = (function() {
            var _i,
                _len,
                _ref,
                _results;
            _ref = this.files;
            _results = [];
            for (_i = 0, _len = _ref.length; _i < _len; _i++) {
              file = _ref[_i];
              if (file.xhr === xhr) {
                _results.push(file);
              }
            }
            return _results;
          }).call(this);
        };
        Dropzone.prototype.cancelUpload = function(file) {
          var groupedFile,
              groupedFiles,
              _i,
              _j,
              _len,
              _len1,
              _ref;
          if (file.status === Dropzone.UPLOADING) {
            groupedFiles = this._getFilesWithXhr(file.xhr);
            for (_i = 0, _len = groupedFiles.length; _i < _len; _i++) {
              groupedFile = groupedFiles[_i];
              groupedFile.status = Dropzone.CANCELED;
            }
            file.xhr.abort();
            for (_j = 0, _len1 = groupedFiles.length; _j < _len1; _j++) {
              groupedFile = groupedFiles[_j];
              this.emit("canceled", groupedFile);
            }
            if (this.options.uploadMultiple) {
              this.emit("canceledmultiple", groupedFiles);
            }
          } else if ((_ref = file.status) === Dropzone.ADDED || _ref === Dropzone.QUEUED) {
            file.status = Dropzone.CANCELED;
            this.emit("canceled", file);
            if (this.options.uploadMultiple) {
              this.emit("canceledmultiple", [file]);
            }
          }
          if (this.options.autoProcessQueue) {
            return this.processQueue();
          }
        };
        resolveOption = function() {
          var args,
              option;
          option = arguments[0], args = 2 <= arguments.length ? __slice.call(arguments, 1) : [];
          if (typeof option === 'function') {
            return option.apply(this, args);
          }
          return option;
        };
        Dropzone.prototype.uploadFile = function(file) {
          return this.uploadFiles([file]);
        };
        Dropzone.prototype.uploadFiles = function(files) {
          var file,
              formData,
              handleError,
              headerName,
              headerValue,
              headers,
              i,
              input,
              inputName,
              inputType,
              key,
              method,
              option,
              progressObj,
              response,
              updateProgress,
              url,
              value,
              xhr,
              _i,
              _j,
              _k,
              _l,
              _len,
              _len1,
              _len2,
              _len3,
              _m,
              _ref,
              _ref1,
              _ref2,
              _ref3,
              _ref4,
              _ref5;
          xhr = new XMLHttpRequest();
          for (_i = 0, _len = files.length; _i < _len; _i++) {
            file = files[_i];
            file.xhr = xhr;
          }
          method = resolveOption(this.options.method, files);
          url = resolveOption(this.options.url, files);
          xhr.open(method, url, true);
          xhr.withCredentials = !!this.options.withCredentials;
          response = null;
          handleError = (function(_this) {
            return function() {
              var _j,
                  _len1,
                  _results;
              _results = [];
              for (_j = 0, _len1 = files.length; _j < _len1; _j++) {
                file = files[_j];
                _results.push(_this._errorProcessing(files, response || _this.options.dictResponseError.replace("{{statusCode}}", xhr.status), xhr));
              }
              return _results;
            };
          })(this);
          updateProgress = (function(_this) {
            return function(e) {
              var allFilesFinished,
                  progress,
                  _j,
                  _k,
                  _l,
                  _len1,
                  _len2,
                  _len3,
                  _results;
              if (e != null) {
                progress = 100 * e.loaded / e.total;
                for (_j = 0, _len1 = files.length; _j < _len1; _j++) {
                  file = files[_j];
                  file.upload = {
                    progress: progress,
                    total: e.total,
                    bytesSent: e.loaded
                  };
                }
              } else {
                allFilesFinished = true;
                progress = 100;
                for (_k = 0, _len2 = files.length; _k < _len2; _k++) {
                  file = files[_k];
                  if (!(file.upload.progress === 100 && file.upload.bytesSent === file.upload.total)) {
                    allFilesFinished = false;
                  }
                  file.upload.progress = progress;
                  file.upload.bytesSent = file.upload.total;
                }
                if (allFilesFinished) {
                  return;
                }
              }
              _results = [];
              for (_l = 0, _len3 = files.length; _l < _len3; _l++) {
                file = files[_l];
                _results.push(_this.emit("uploadprogress", file, progress, file.upload.bytesSent));
              }
              return _results;
            };
          })(this);
          xhr.onload = (function(_this) {
            return function(e) {
              var _ref;
              if (files[0].status === Dropzone.CANCELED) {
                return;
              }
              if (xhr.readyState !== 4) {
                return;
              }
              response = xhr.responseText;
              if (xhr.getResponseHeader("content-type") && ~xhr.getResponseHeader("content-type").indexOf("application/json")) {
                try {
                  response = JSON.parse(response);
                } catch (_error) {
                  e = _error;
                  response = "Invalid JSON response from server.";
                }
              }
              updateProgress();
              if (!((200 <= (_ref = xhr.status) && _ref < 300))) {
                return handleError();
              } else {
                return _this._finished(files, response, e);
              }
            };
          })(this);
          xhr.onerror = (function(_this) {
            return function() {
              if (files[0].status === Dropzone.CANCELED) {
                return;
              }
              return handleError();
            };
          })(this);
          progressObj = (_ref = xhr.upload) != null ? _ref : xhr;
          progressObj.onprogress = updateProgress;
          headers = {
            "Accept": "application/json",
            "Cache-Control": "no-cache",
            "X-Requested-With": "XMLHttpRequest"
          };
          if (this.options.headers) {
            extend(headers, this.options.headers);
          }
          for (headerName in headers) {
            headerValue = headers[headerName];
            if (headerValue) {
              xhr.setRequestHeader(headerName, headerValue);
            }
          }
          formData = new FormData();
          if (this.options.params) {
            _ref1 = this.options.params;
            for (key in _ref1) {
              value = _ref1[key];
              formData.append(key, value);
            }
          }
          for (_j = 0, _len1 = files.length; _j < _len1; _j++) {
            file = files[_j];
            this.emit("sending", file, xhr, formData);
          }
          if (this.options.uploadMultiple) {
            this.emit("sendingmultiple", files, xhr, formData);
          }
          if (this.element.tagName === "FORM") {
            _ref2 = this.element.querySelectorAll("input, textarea, select, button");
            for (_k = 0, _len2 = _ref2.length; _k < _len2; _k++) {
              input = _ref2[_k];
              inputName = input.getAttribute("name");
              inputType = input.getAttribute("type");
              if (input.tagName === "SELECT" && input.hasAttribute("multiple")) {
                _ref3 = input.options;
                for (_l = 0, _len3 = _ref3.length; _l < _len3; _l++) {
                  option = _ref3[_l];
                  if (option.selected) {
                    formData.append(inputName, option.value);
                  }
                }
              } else if (!inputType || ((_ref4 = inputType.toLowerCase()) !== "checkbox" && _ref4 !== "radio") || input.checked) {
                formData.append(inputName, input.value);
              }
            }
          }
          for (i = _m = 0, _ref5 = files.length - 1; 0 <= _ref5 ? _m <= _ref5 : _m >= _ref5; i = 0 <= _ref5 ? ++_m : --_m) {
            formData.append(this._getParamName(i), files[i], files[i].name);
          }
          return this.submitRequest(xhr, formData, files);
        };
        Dropzone.prototype.submitRequest = function(xhr, formData, files) {
          return xhr.send(formData);
        };
        Dropzone.prototype._finished = function(files, responseText, e) {
          var file,
              _i,
              _len;
          for (_i = 0, _len = files.length; _i < _len; _i++) {
            file = files[_i];
            file.status = Dropzone.SUCCESS;
            this.emit("success", file, responseText, e);
            this.emit("complete", file);
          }
          if (this.options.uploadMultiple) {
            this.emit("successmultiple", files, responseText, e);
            this.emit("completemultiple", files);
          }
          if (this.options.autoProcessQueue) {
            return this.processQueue();
          }
        };
        Dropzone.prototype._errorProcessing = function(files, message, xhr) {
          var file,
              _i,
              _len;
          for (_i = 0, _len = files.length; _i < _len; _i++) {
            file = files[_i];
            file.status = Dropzone.ERROR;
            this.emit("error", file, message, xhr);
            this.emit("complete", file);
          }
          if (this.options.uploadMultiple) {
            this.emit("errormultiple", files, message, xhr);
            this.emit("completemultiple", files);
          }
          if (this.options.autoProcessQueue) {
            return this.processQueue();
          }
        };
        return Dropzone;
      })(Emitter);
      Dropzone.version = "4.2.0";
      Dropzone.options = {};
      Dropzone.optionsForElement = function(element) {
        if (element.getAttribute("id")) {
          return Dropzone.options[camelize(element.getAttribute("id"))];
        } else {
          return void 0;
        }
      };
      Dropzone.instances = [];
      Dropzone.forElement = function(element) {
        if (typeof element === "string") {
          element = document.querySelector(element);
        }
        if ((element != null ? element.dropzone : void 0) == null) {
          throw new Error("No Dropzone found for given element. This is probably because you're trying to access it before Dropzone had the time to initialize. Use the `init` option to setup any additional observers on your Dropzone.");
        }
        return element.dropzone;
      };
      Dropzone.autoDiscover = true;
      Dropzone.discover = function() {
        var checkElements,
            dropzone,
            dropzones,
            _i,
            _len,
            _results;
        if (document.querySelectorAll) {
          dropzones = document.querySelectorAll(".dropzone");
        } else {
          dropzones = [];
          checkElements = function(elements) {
            var el,
                _i,
                _len,
                _results;
            _results = [];
            for (_i = 0, _len = elements.length; _i < _len; _i++) {
              el = elements[_i];
              if (/(^| )dropzone($| )/.test(el.className)) {
                _results.push(dropzones.push(el));
              } else {
                _results.push(void 0);
              }
            }
            return _results;
          };
          checkElements(document.getElementsByTagName("div"));
          checkElements(document.getElementsByTagName("form"));
        }
        _results = [];
        for (_i = 0, _len = dropzones.length; _i < _len; _i++) {
          dropzone = dropzones[_i];
          if (Dropzone.optionsForElement(dropzone) !== false) {
            _results.push(new Dropzone(dropzone));
          } else {
            _results.push(void 0);
          }
        }
        return _results;
      };
      Dropzone.blacklistedBrowsers = [/opera.*Macintosh.*version\/12/i];
      Dropzone.isBrowserSupported = function() {
        var capableBrowser,
            regex,
            _i,
            _len,
            _ref;
        capableBrowser = true;
        if (window.File && window.FileReader && window.FileList && window.Blob && window.FormData && document.querySelector) {
          if (!("classList" in document.createElement("a"))) {
            capableBrowser = false;
          } else {
            _ref = Dropzone.blacklistedBrowsers;
            for (_i = 0, _len = _ref.length; _i < _len; _i++) {
              regex = _ref[_i];
              if (regex.test(navigator.userAgent)) {
                capableBrowser = false;
                continue;
              }
            }
          }
        } else {
          capableBrowser = false;
        }
        return capableBrowser;
      };
      without = function(list, rejectedItem) {
        var item,
            _i,
            _len,
            _results;
        _results = [];
        for (_i = 0, _len = list.length; _i < _len; _i++) {
          item = list[_i];
          if (item !== rejectedItem) {
            _results.push(item);
          }
        }
        return _results;
      };
      camelize = function(str) {
        return str.replace(/[\-_](\w)/g, function(match) {
          return match.charAt(1).toUpperCase();
        });
      };
      Dropzone.createElement = function(string) {
        var div;
        div = document.createElement("div");
        div.innerHTML = string;
        return div.childNodes[0];
      };
      Dropzone.elementInside = function(element, container) {
        if (element === container) {
          return true;
        }
        while (element = element.parentNode) {
          if (element === container) {
            return true;
          }
        }
        return false;
      };
      Dropzone.getElement = function(el, name) {
        var element;
        if (typeof el === "string") {
          element = document.querySelector(el);
        } else if (el.nodeType != null) {
          element = el;
        }
        if (element == null) {
          throw new Error("Invalid `" + name + "` option provided. Please provide a CSS selector or a plain HTML element.");
        }
        return element;
      };
      Dropzone.getElements = function(els, name) {
        var e,
            el,
            elements,
            _i,
            _j,
            _len,
            _len1,
            _ref;
        if (els instanceof Array) {
          elements = [];
          try {
            for (_i = 0, _len = els.length; _i < _len; _i++) {
              el = els[_i];
              elements.push(this.getElement(el, name));
            }
          } catch (_error) {
            e = _error;
            elements = null;
          }
        } else if (typeof els === "string") {
          elements = [];
          _ref = document.querySelectorAll(els);
          for (_j = 0, _len1 = _ref.length; _j < _len1; _j++) {
            el = _ref[_j];
            elements.push(el);
          }
        } else if (els.nodeType != null) {
          elements = [els];
        }
        if (!((elements != null) && elements.length)) {
          throw new Error("Invalid `" + name + "` option provided. Please provide a CSS selector, a plain HTML element or a list of those.");
        }
        return elements;
      };
      Dropzone.confirm = function(question, accepted, rejected) {
        if (window.confirm(question)) {
          return accepted();
        } else if (rejected != null) {
          return rejected();
        }
      };
      Dropzone.isValidFile = function(file, acceptedFiles) {
        var baseMimeType,
            mimeType,
            validType,
            _i,
            _len;
        if (!acceptedFiles) {
          return true;
        }
        acceptedFiles = acceptedFiles.split(",");
        mimeType = file.type;
        baseMimeType = mimeType.replace(/\/.*$/, "");
        for (_i = 0, _len = acceptedFiles.length; _i < _len; _i++) {
          validType = acceptedFiles[_i];
          validType = validType.trim();
          if (validType.charAt(0) === ".") {
            if (file.name.toLowerCase().indexOf(validType.toLowerCase(), file.name.length - validType.length) !== -1) {
              return true;
            }
          } else if (/\/\*$/.test(validType)) {
            if (baseMimeType === validType.replace(/\/.*$/, "")) {
              return true;
            }
          } else {
            if (mimeType === validType) {
              return true;
            }
          }
        }
        return false;
      };
      if (typeof jQuery !== "undefined" && jQuery !== null) {
        jQuery.fn.dropzone = function(options) {
          return this.each(function() {
            return new Dropzone(this, options);
          });
        };
      }
      if (typeof module !== "undefined" && module !== null) {
        module.exports = Dropzone;
      } else {
        window.Dropzone = Dropzone;
      }
      Dropzone.ADDED = "added";
      Dropzone.QUEUED = "queued";
      Dropzone.ACCEPTED = Dropzone.QUEUED;
      Dropzone.UPLOADING = "uploading";
      Dropzone.PROCESSING = Dropzone.UPLOADING;
      Dropzone.CANCELED = "canceled";
      Dropzone.ERROR = "error";
      Dropzone.SUCCESS = "success";
      detectVerticalSquash = function(img) {
        var alpha,
            canvas,
            ctx,
            data,
            ey,
            ih,
            iw,
            py,
            ratio,
            sy;
        iw = img.naturalWidth;
        ih = img.naturalHeight;
        canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = ih;
        ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        data = ctx.getImageData(0, 0, 1, ih).data;
        sy = 0;
        ey = ih;
        py = ih;
        while (py > sy) {
          alpha = data[(py - 1) * 4 + 3];
          if (alpha === 0) {
            ey = py;
          } else {
            sy = py;
          }
          py = (ey + sy) >> 1;
        }
        ratio = py / ih;
        if (ratio === 0) {
          return 1;
        } else {
          return ratio;
        }
      };
      drawImageIOSFix = function(ctx, img, sx, sy, sw, sh, dx, dy, dw, dh) {
        var vertSquashRatio;
        vertSquashRatio = detectVerticalSquash(img);
        return ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh / vertSquashRatio);
      };
      contentLoaded = function(win, fn) {
        var add,
            doc,
            done,
            init,
            poll,
            pre,
            rem,
            root,
            top;
        done = false;
        top = true;
        doc = win.document;
        root = doc.documentElement;
        add = (doc.addEventListener ? "addEventListener" : "attachEvent");
        rem = (doc.addEventListener ? "removeEventListener" : "detachEvent");
        pre = (doc.addEventListener ? "" : "on");
        init = function(e) {
          if (e.type === "readystatechange" && doc.readyState !== "complete") {
            return;
          }
          (e.type === "load" ? win : doc)[rem](pre + e.type, init, false);
          if (!done && (done = true)) {
            return fn.call(win, e.type || e);
          }
        };
        poll = function() {
          var e;
          try {
            root.doScroll("left");
          } catch (_error) {
            e = _error;
            setTimeout(poll, 50);
            return;
          }
          return init("poll");
        };
        if (doc.readyState !== "complete") {
          if (doc.createEventObject && root.doScroll) {
            try {
              top = !win.frameElement;
            } catch (_error) {}
            if (top) {
              poll();
            }
          }
          doc[add](pre + "DOMContentLoaded", init, false);
          doc[add](pre + "readystatechange", init, false);
          return win[add](pre + "load", init, false);
        }
      };
      Dropzone._autoDiscoverFunction = function() {
        if (Dropzone.autoDiscover) {
          return Dropzone.discover();
        }
      };
      contentLoaded(window, Dropzone._autoDiscoverFunction);
    }).call(this);
  })(req('e'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5b", ["5a"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = req('5a');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5c", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "format cjs";
  (function(global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() : typeof define === 'function' && define.amd ? define(factory) : global.moment = factory();
  }(this, function() {
    'use strict';
    var hookCallback;
    function utils_hooks__hooks() {
      return hookCallback.apply(null, arguments);
    }
    function setHookCallback(callback) {
      hookCallback = callback;
    }
    function isArray(input) {
      return Object.prototype.toString.call(input) === '[object Array]';
    }
    function isDate(input) {
      return input instanceof Date || Object.prototype.toString.call(input) === '[object Date]';
    }
    function map(arr, fn) {
      var res = [],
          i;
      for (i = 0; i < arr.length; ++i) {
        res.push(fn(arr[i], i));
      }
      return res;
    }
    function hasOwnProp(a, b) {
      return Object.prototype.hasOwnProperty.call(a, b);
    }
    function extend(a, b) {
      for (var i in b) {
        if (hasOwnProp(b, i)) {
          a[i] = b[i];
        }
      }
      if (hasOwnProp(b, 'toString')) {
        a.toString = b.toString;
      }
      if (hasOwnProp(b, 'valueOf')) {
        a.valueOf = b.valueOf;
      }
      return a;
    }
    function create_utc__createUTC(input, format, locale, strict) {
      return createLocalOrUTC(input, format, locale, strict, true).utc();
    }
    function defaultParsingFlags() {
      return {
        empty: false,
        unusedTokens: [],
        unusedInput: [],
        overflow: -2,
        charsLeftOver: 0,
        nullInput: false,
        invalidMonth: null,
        invalidFormat: false,
        userInvalidated: false,
        iso: false
      };
    }
    function getParsingFlags(m) {
      if (m._pf == null) {
        m._pf = defaultParsingFlags();
      }
      return m._pf;
    }
    function valid__isValid(m) {
      if (m._isValid == null) {
        var flags = getParsingFlags(m);
        m._isValid = !isNaN(m._d.getTime()) && flags.overflow < 0 && !flags.empty && !flags.invalidMonth && !flags.invalidWeekday && !flags.nullInput && !flags.invalidFormat && !flags.userInvalidated;
        if (m._strict) {
          m._isValid = m._isValid && flags.charsLeftOver === 0 && flags.unusedTokens.length === 0 && flags.bigHour === undefined;
        }
      }
      return m._isValid;
    }
    function valid__createInvalid(flags) {
      var m = create_utc__createUTC(NaN);
      if (flags != null) {
        extend(getParsingFlags(m), flags);
      } else {
        getParsingFlags(m).userInvalidated = true;
      }
      return m;
    }
    var momentProperties = utils_hooks__hooks.momentProperties = [];
    function copyConfig(to, from) {
      var i,
          prop,
          val;
      if (typeof from._isAMomentObject !== 'undefined') {
        to._isAMomentObject = from._isAMomentObject;
      }
      if (typeof from._i !== 'undefined') {
        to._i = from._i;
      }
      if (typeof from._f !== 'undefined') {
        to._f = from._f;
      }
      if (typeof from._l !== 'undefined') {
        to._l = from._l;
      }
      if (typeof from._strict !== 'undefined') {
        to._strict = from._strict;
      }
      if (typeof from._tzm !== 'undefined') {
        to._tzm = from._tzm;
      }
      if (typeof from._isUTC !== 'undefined') {
        to._isUTC = from._isUTC;
      }
      if (typeof from._offset !== 'undefined') {
        to._offset = from._offset;
      }
      if (typeof from._pf !== 'undefined') {
        to._pf = getParsingFlags(from);
      }
      if (typeof from._locale !== 'undefined') {
        to._locale = from._locale;
      }
      if (momentProperties.length > 0) {
        for (i in momentProperties) {
          prop = momentProperties[i];
          val = from[prop];
          if (typeof val !== 'undefined') {
            to[prop] = val;
          }
        }
      }
      return to;
    }
    var updateInProgress = false;
    function Moment(config) {
      copyConfig(this, config);
      this._d = new Date(config._d != null ? config._d.getTime() : NaN);
      if (updateInProgress === false) {
        updateInProgress = true;
        utils_hooks__hooks.updateOffset(this);
        updateInProgress = false;
      }
    }
    function isMoment(obj) {
      return obj instanceof Moment || (obj != null && obj._isAMomentObject != null);
    }
    function absFloor(number) {
      if (number < 0) {
        return Math.ceil(number);
      } else {
        return Math.floor(number);
      }
    }
    function toInt(argumentForCoercion) {
      var coercedNumber = +argumentForCoercion,
          value = 0;
      if (coercedNumber !== 0 && isFinite(coercedNumber)) {
        value = absFloor(coercedNumber);
      }
      return value;
    }
    function compareArrays(array1, array2, dontConvert) {
      var len = Math.min(array1.length, array2.length),
          lengthDiff = Math.abs(array1.length - array2.length),
          diffs = 0,
          i;
      for (i = 0; i < len; i++) {
        if ((dontConvert && array1[i] !== array2[i]) || (!dontConvert && toInt(array1[i]) !== toInt(array2[i]))) {
          diffs++;
        }
      }
      return diffs + lengthDiff;
    }
    function Locale() {}
    var locales = {};
    var globalLocale;
    function normalizeLocale(key) {
      return key ? key.toLowerCase().replace('_', '-') : key;
    }
    function chooseLocale(names) {
      var i = 0,
          j,
          next,
          locale,
          split;
      while (i < names.length) {
        split = normalizeLocale(names[i]).split('-');
        j = split.length;
        next = normalizeLocale(names[i + 1]);
        next = next ? next.split('-') : null;
        while (j > 0) {
          locale = loadLocale(split.slice(0, j).join('-'));
          if (locale) {
            return locale;
          }
          if (next && next.length >= j && compareArrays(split, next, true) >= j - 1) {
            break;
          }
          j--;
        }
        i++;
      }
      return null;
    }
    function loadLocale(name) {
      var oldLocale = null;
      if (!locales[name] && typeof module !== 'undefined' && module && module.exports) {
        try {
          oldLocale = globalLocale._abbr;
          req('./locale/' + name);
          locale_locales__getSetGlobalLocale(oldLocale);
        } catch (e) {}
      }
      return locales[name];
    }
    function locale_locales__getSetGlobalLocale(key, values) {
      var data;
      if (key) {
        if (typeof values === 'undefined') {
          data = locale_locales__getLocale(key);
        } else {
          data = defineLocale(key, values);
        }
        if (data) {
          globalLocale = data;
        }
      }
      return globalLocale._abbr;
    }
    function defineLocale(name, values) {
      if (values !== null) {
        values.abbr = name;
        locales[name] = locales[name] || new Locale();
        locales[name].set(values);
        locale_locales__getSetGlobalLocale(name);
        return locales[name];
      } else {
        delete locales[name];
        return null;
      }
    }
    function locale_locales__getLocale(key) {
      var locale;
      if (key && key._locale && key._locale._abbr) {
        key = key._locale._abbr;
      }
      if (!key) {
        return globalLocale;
      }
      if (!isArray(key)) {
        locale = loadLocale(key);
        if (locale) {
          return locale;
        }
        key = [key];
      }
      return chooseLocale(key);
    }
    var aliases = {};
    function addUnitAlias(unit, shorthand) {
      var lowerCase = unit.toLowerCase();
      aliases[lowerCase] = aliases[lowerCase + 's'] = aliases[shorthand] = unit;
    }
    function normalizeUnits(units) {
      return typeof units === 'string' ? aliases[units] || aliases[units.toLowerCase()] : undefined;
    }
    function normalizeObjectUnits(inputObject) {
      var normalizedInput = {},
          normalizedProp,
          prop;
      for (prop in inputObject) {
        if (hasOwnProp(inputObject, prop)) {
          normalizedProp = normalizeUnits(prop);
          if (normalizedProp) {
            normalizedInput[normalizedProp] = inputObject[prop];
          }
        }
      }
      return normalizedInput;
    }
    function makeGetSet(unit, keepTime) {
      return function(value) {
        if (value != null) {
          get_set__set(this, unit, value);
          utils_hooks__hooks.updateOffset(this, keepTime);
          return this;
        } else {
          return get_set__get(this, unit);
        }
      };
    }
    function get_set__get(mom, unit) {
      return mom._d['get' + (mom._isUTC ? 'UTC' : '') + unit]();
    }
    function get_set__set(mom, unit, value) {
      return mom._d['set' + (mom._isUTC ? 'UTC' : '') + unit](value);
    }
    function getSet(units, value) {
      var unit;
      if (typeof units === 'object') {
        for (unit in units) {
          this.set(unit, units[unit]);
        }
      } else {
        units = normalizeUnits(units);
        if (typeof this[units] === 'function') {
          return this[units](value);
        }
      }
      return this;
    }
    function zeroFill(number, targetLength, forceSign) {
      var absNumber = '' + Math.abs(number),
          zerosToFill = targetLength - absNumber.length,
          sign = number >= 0;
      return (sign ? (forceSign ? '+' : '') : '-') + Math.pow(10, Math.max(0, zerosToFill)).toString().substr(1) + absNumber;
    }
    var formattingTokens = /(\[[^\[]*\])|(\\)?(Mo|MM?M?M?|Do|DDDo|DD?D?D?|ddd?d?|do?|w[o|w]?|W[o|W]?|Q|YYYYYY|YYYYY|YYYY|YY|gg(ggg?)?|GG(GGG?)?|e|E|a|A|hh?|HH?|mm?|ss?|S{1,9}|x|X|zz?|ZZ?|.)/g;
    var localFormattingTokens = /(\[[^\[]*\])|(\\)?(LTS|LT|LL?L?L?|l{1,4})/g;
    var formatFunctions = {};
    var formatTokenFunctions = {};
    function addFormatToken(token, padded, ordinal, callback) {
      var func = callback;
      if (typeof callback === 'string') {
        func = function() {
          return this[callback]();
        };
      }
      if (token) {
        formatTokenFunctions[token] = func;
      }
      if (padded) {
        formatTokenFunctions[padded[0]] = function() {
          return zeroFill(func.apply(this, arguments), padded[1], padded[2]);
        };
      }
      if (ordinal) {
        formatTokenFunctions[ordinal] = function() {
          return this.localeData().ordinal(func.apply(this, arguments), token);
        };
      }
    }
    function removeFormattingTokens(input) {
      if (input.match(/\[[\s\S]/)) {
        return input.replace(/^\[|\]$/g, '');
      }
      return input.replace(/\\/g, '');
    }
    function makeFormatFunction(format) {
      var array = format.match(formattingTokens),
          i,
          length;
      for (i = 0, length = array.length; i < length; i++) {
        if (formatTokenFunctions[array[i]]) {
          array[i] = formatTokenFunctions[array[i]];
        } else {
          array[i] = removeFormattingTokens(array[i]);
        }
      }
      return function(mom) {
        var output = '';
        for (i = 0; i < length; i++) {
          output += array[i] instanceof Function ? array[i].call(mom, format) : array[i];
        }
        return output;
      };
    }
    function formatMoment(m, format) {
      if (!m.isValid()) {
        return m.localeData().invalidDate();
      }
      format = expandFormat(format, m.localeData());
      formatFunctions[format] = formatFunctions[format] || makeFormatFunction(format);
      return formatFunctions[format](m);
    }
    function expandFormat(format, locale) {
      var i = 5;
      function replaceLongDateFormatTokens(input) {
        return locale.longDateFormat(input) || input;
      }
      localFormattingTokens.lastIndex = 0;
      while (i >= 0 && localFormattingTokens.test(format)) {
        format = format.replace(localFormattingTokens, replaceLongDateFormatTokens);
        localFormattingTokens.lastIndex = 0;
        i -= 1;
      }
      return format;
    }
    var match1 = /\d/;
    var match2 = /\d\d/;
    var match3 = /\d{3}/;
    var match4 = /\d{4}/;
    var match6 = /[+-]?\d{6}/;
    var match1to2 = /\d\d?/;
    var match1to3 = /\d{1,3}/;
    var match1to4 = /\d{1,4}/;
    var match1to6 = /[+-]?\d{1,6}/;
    var matchUnsigned = /\d+/;
    var matchSigned = /[+-]?\d+/;
    var matchOffset = /Z|[+-]\d\d:?\d\d/gi;
    var matchTimestamp = /[+-]?\d+(\.\d{1,3})?/;
    var matchWord = /[0-9]*['a-z\u00A0-\u05FF\u0700-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]+|[\u0600-\u06FF\/]+(\s*?[\u0600-\u06FF]+){1,2}/i;
    var regexes = {};
    function isFunction(sth) {
      return typeof sth === 'function' && Object.prototype.toString.call(sth) === '[object Function]';
    }
    function addRegexToken(token, regex, strictRegex) {
      regexes[token] = isFunction(regex) ? regex : function(isStrict) {
        return (isStrict && strictRegex) ? strictRegex : regex;
      };
    }
    function getParseRegexForToken(token, config) {
      if (!hasOwnProp(regexes, token)) {
        return new RegExp(unescapeFormat(token));
      }
      return regexes[token](config._strict, config._locale);
    }
    function unescapeFormat(s) {
      return s.replace('\\', '').replace(/\\(\[)|\\(\])|\[([^\]\[]*)\]|\\(.)/g, function(matched, p1, p2, p3, p4) {
        return p1 || p2 || p3 || p4;
      }).replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    }
    var tokens = {};
    function addParseToken(token, callback) {
      var i,
          func = callback;
      if (typeof token === 'string') {
        token = [token];
      }
      if (typeof callback === 'number') {
        func = function(input, array) {
          array[callback] = toInt(input);
        };
      }
      for (i = 0; i < token.length; i++) {
        tokens[token[i]] = func;
      }
    }
    function addWeekParseToken(token, callback) {
      addParseToken(token, function(input, array, config, token) {
        config._w = config._w || {};
        callback(input, config._w, config, token);
      });
    }
    function addTimeToArrayFromToken(token, input, config) {
      if (input != null && hasOwnProp(tokens, token)) {
        tokens[token](input, config._a, config, token);
      }
    }
    var YEAR = 0;
    var MONTH = 1;
    var DATE = 2;
    var HOUR = 3;
    var MINUTE = 4;
    var SECOND = 5;
    var MILLISECOND = 6;
    function daysInMonth(year, month) {
      return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    }
    addFormatToken('M', ['MM', 2], 'Mo', function() {
      return this.month() + 1;
    });
    addFormatToken('MMM', 0, 0, function(format) {
      return this.localeData().monthsShort(this, format);
    });
    addFormatToken('MMMM', 0, 0, function(format) {
      return this.localeData().months(this, format);
    });
    addUnitAlias('month', 'M');
    addRegexToken('M', match1to2);
    addRegexToken('MM', match1to2, match2);
    addRegexToken('MMM', matchWord);
    addRegexToken('MMMM', matchWord);
    addParseToken(['M', 'MM'], function(input, array) {
      array[MONTH] = toInt(input) - 1;
    });
    addParseToken(['MMM', 'MMMM'], function(input, array, config, token) {
      var month = config._locale.monthsParse(input, token, config._strict);
      if (month != null) {
        array[MONTH] = month;
      } else {
        getParsingFlags(config).invalidMonth = input;
      }
    });
    var defaultLocaleMonths = 'January_February_March_April_May_June_July_August_September_October_November_December'.split('_');
    function localeMonths(m) {
      return this._months[m.month()];
    }
    var defaultLocaleMonthsShort = 'Jan_Feb_Mar_Apr_May_Jun_Jul_Aug_Sep_Oct_Nov_Dec'.split('_');
    function localeMonthsShort(m) {
      return this._monthsShort[m.month()];
    }
    function localeMonthsParse(monthName, format, strict) {
      var i,
          mom,
          regex;
      if (!this._monthsParse) {
        this._monthsParse = [];
        this._longMonthsParse = [];
        this._shortMonthsParse = [];
      }
      for (i = 0; i < 12; i++) {
        mom = create_utc__createUTC([2000, i]);
        if (strict && !this._longMonthsParse[i]) {
          this._longMonthsParse[i] = new RegExp('^' + this.months(mom, '').replace('.', '') + '$', 'i');
          this._shortMonthsParse[i] = new RegExp('^' + this.monthsShort(mom, '').replace('.', '') + '$', 'i');
        }
        if (!strict && !this._monthsParse[i]) {
          regex = '^' + this.months(mom, '') + '|^' + this.monthsShort(mom, '');
          this._monthsParse[i] = new RegExp(regex.replace('.', ''), 'i');
        }
        if (strict && format === 'MMMM' && this._longMonthsParse[i].test(monthName)) {
          return i;
        } else if (strict && format === 'MMM' && this._shortMonthsParse[i].test(monthName)) {
          return i;
        } else if (!strict && this._monthsParse[i].test(monthName)) {
          return i;
        }
      }
    }
    function setMonth(mom, value) {
      var dayOfMonth;
      if (typeof value === 'string') {
        value = mom.localeData().monthsParse(value);
        if (typeof value !== 'number') {
          return mom;
        }
      }
      dayOfMonth = Math.min(mom.date(), daysInMonth(mom.year(), value));
      mom._d['set' + (mom._isUTC ? 'UTC' : '') + 'Month'](value, dayOfMonth);
      return mom;
    }
    function getSetMonth(value) {
      if (value != null) {
        setMonth(this, value);
        utils_hooks__hooks.updateOffset(this, true);
        return this;
      } else {
        return get_set__get(this, 'Month');
      }
    }
    function getDaysInMonth() {
      return daysInMonth(this.year(), this.month());
    }
    function checkOverflow(m) {
      var overflow;
      var a = m._a;
      if (a && getParsingFlags(m).overflow === -2) {
        overflow = a[MONTH] < 0 || a[MONTH] > 11 ? MONTH : a[DATE] < 1 || a[DATE] > daysInMonth(a[YEAR], a[MONTH]) ? DATE : a[HOUR] < 0 || a[HOUR] > 24 || (a[HOUR] === 24 && (a[MINUTE] !== 0 || a[SECOND] !== 0 || a[MILLISECOND] !== 0)) ? HOUR : a[MINUTE] < 0 || a[MINUTE] > 59 ? MINUTE : a[SECOND] < 0 || a[SECOND] > 59 ? SECOND : a[MILLISECOND] < 0 || a[MILLISECOND] > 999 ? MILLISECOND : -1;
        if (getParsingFlags(m)._overflowDayOfYear && (overflow < YEAR || overflow > DATE)) {
          overflow = DATE;
        }
        getParsingFlags(m).overflow = overflow;
      }
      return m;
    }
    function warn(msg) {
      if (utils_hooks__hooks.suppressDeprecationWarnings === false && typeof console !== 'undefined' && console.warn) {
        console.warn('Deprecation warning: ' + msg);
      }
    }
    function deprecate(msg, fn) {
      var firstTime = true;
      return extend(function() {
        if (firstTime) {
          warn(msg + '\n' + (new Error()).stack);
          firstTime = false;
        }
        return fn.apply(this, arguments);
      }, fn);
    }
    var deprecations = {};
    function deprecateSimple(name, msg) {
      if (!deprecations[name]) {
        warn(msg);
        deprecations[name] = true;
      }
    }
    utils_hooks__hooks.suppressDeprecationWarnings = false;
    var from_string__isoRegex = /^\s*(?:[+-]\d{6}|\d{4})-(?:(\d\d-\d\d)|(W\d\d$)|(W\d\d-\d)|(\d\d\d))((T| )(\d\d(:\d\d(:\d\d(\.\d+)?)?)?)?([\+\-]\d\d(?::?\d\d)?|\s*Z)?)?$/;
    var isoDates = [['YYYYYY-MM-DD', /[+-]\d{6}-\d{2}-\d{2}/], ['YYYY-MM-DD', /\d{4}-\d{2}-\d{2}/], ['GGGG-[W]WW-E', /\d{4}-W\d{2}-\d/], ['GGGG-[W]WW', /\d{4}-W\d{2}/], ['YYYY-DDD', /\d{4}-\d{3}/]];
    var isoTimes = [['HH:mm:ss.SSSS', /(T| )\d\d:\d\d:\d\d\.\d+/], ['HH:mm:ss', /(T| )\d\d:\d\d:\d\d/], ['HH:mm', /(T| )\d\d:\d\d/], ['HH', /(T| )\d\d/]];
    var aspNetJsonRegex = /^\/?Date\((\-?\d+)/i;
    function configFromISO(config) {
      var i,
          l,
          string = config._i,
          match = from_string__isoRegex.exec(string);
      if (match) {
        getParsingFlags(config).iso = true;
        for (i = 0, l = isoDates.length; i < l; i++) {
          if (isoDates[i][1].exec(string)) {
            config._f = isoDates[i][0];
            break;
          }
        }
        for (i = 0, l = isoTimes.length; i < l; i++) {
          if (isoTimes[i][1].exec(string)) {
            config._f += (match[6] || ' ') + isoTimes[i][0];
            break;
          }
        }
        if (string.match(matchOffset)) {
          config._f += 'Z';
        }
        configFromStringAndFormat(config);
      } else {
        config._isValid = false;
      }
    }
    function configFromString(config) {
      var matched = aspNetJsonRegex.exec(config._i);
      if (matched !== null) {
        config._d = new Date(+matched[1]);
        return;
      }
      configFromISO(config);
      if (config._isValid === false) {
        delete config._isValid;
        utils_hooks__hooks.createFromInputFallback(config);
      }
    }
    utils_hooks__hooks.createFromInputFallback = deprecate('moment construction falls back to js Date. This is ' + 'discouraged and will be removed in upcoming major ' + 'release. Please refer to ' + 'https://github.com/moment/moment/issues/1407 for more info.', function(config) {
      config._d = new Date(config._i + (config._useUTC ? ' UTC' : ''));
    });
    function createDate(y, m, d, h, M, s, ms) {
      var date = new Date(y, m, d, h, M, s, ms);
      if (y < 1970) {
        date.setFullYear(y);
      }
      return date;
    }
    function createUTCDate(y) {
      var date = new Date(Date.UTC.apply(null, arguments));
      if (y < 1970) {
        date.setUTCFullYear(y);
      }
      return date;
    }
    addFormatToken(0, ['YY', 2], 0, function() {
      return this.year() % 100;
    });
    addFormatToken(0, ['YYYY', 4], 0, 'year');
    addFormatToken(0, ['YYYYY', 5], 0, 'year');
    addFormatToken(0, ['YYYYYY', 6, true], 0, 'year');
    addUnitAlias('year', 'y');
    addRegexToken('Y', matchSigned);
    addRegexToken('YY', match1to2, match2);
    addRegexToken('YYYY', match1to4, match4);
    addRegexToken('YYYYY', match1to6, match6);
    addRegexToken('YYYYYY', match1to6, match6);
    addParseToken(['YYYYY', 'YYYYYY'], YEAR);
    addParseToken('YYYY', function(input, array) {
      array[YEAR] = input.length === 2 ? utils_hooks__hooks.parseTwoDigitYear(input) : toInt(input);
    });
    addParseToken('YY', function(input, array) {
      array[YEAR] = utils_hooks__hooks.parseTwoDigitYear(input);
    });
    function daysInYear(year) {
      return isLeapYear(year) ? 366 : 365;
    }
    function isLeapYear(year) {
      return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    }
    utils_hooks__hooks.parseTwoDigitYear = function(input) {
      return toInt(input) + (toInt(input) > 68 ? 1900 : 2000);
    };
    var getSetYear = makeGetSet('FullYear', false);
    function getIsLeapYear() {
      return isLeapYear(this.year());
    }
    addFormatToken('w', ['ww', 2], 'wo', 'week');
    addFormatToken('W', ['WW', 2], 'Wo', 'isoWeek');
    addUnitAlias('week', 'w');
    addUnitAlias('isoWeek', 'W');
    addRegexToken('w', match1to2);
    addRegexToken('ww', match1to2, match2);
    addRegexToken('W', match1to2);
    addRegexToken('WW', match1to2, match2);
    addWeekParseToken(['w', 'ww', 'W', 'WW'], function(input, week, config, token) {
      week[token.substr(0, 1)] = toInt(input);
    });
    function weekOfYear(mom, firstDayOfWeek, firstDayOfWeekOfYear) {
      var end = firstDayOfWeekOfYear - firstDayOfWeek,
          daysToDayOfWeek = firstDayOfWeekOfYear - mom.day(),
          adjustedMoment;
      if (daysToDayOfWeek > end) {
        daysToDayOfWeek -= 7;
      }
      if (daysToDayOfWeek < end - 7) {
        daysToDayOfWeek += 7;
      }
      adjustedMoment = local__createLocal(mom).add(daysToDayOfWeek, 'd');
      return {
        week: Math.ceil(adjustedMoment.dayOfYear() / 7),
        year: adjustedMoment.year()
      };
    }
    function localeWeek(mom) {
      return weekOfYear(mom, this._week.dow, this._week.doy).week;
    }
    var defaultLocaleWeek = {
      dow: 0,
      doy: 6
    };
    function localeFirstDayOfWeek() {
      return this._week.dow;
    }
    function localeFirstDayOfYear() {
      return this._week.doy;
    }
    function getSetWeek(input) {
      var week = this.localeData().week(this);
      return input == null ? week : this.add((input - week) * 7, 'd');
    }
    function getSetISOWeek(input) {
      var week = weekOfYear(this, 1, 4).week;
      return input == null ? week : this.add((input - week) * 7, 'd');
    }
    addFormatToken('DDD', ['DDDD', 3], 'DDDo', 'dayOfYear');
    addUnitAlias('dayOfYear', 'DDD');
    addRegexToken('DDD', match1to3);
    addRegexToken('DDDD', match3);
    addParseToken(['DDD', 'DDDD'], function(input, array, config) {
      config._dayOfYear = toInt(input);
    });
    function dayOfYearFromWeeks(year, week, weekday, firstDayOfWeekOfYear, firstDayOfWeek) {
      var week1Jan = 6 + firstDayOfWeek - firstDayOfWeekOfYear,
          janX = createUTCDate(year, 0, 1 + week1Jan),
          d = janX.getUTCDay(),
          dayOfYear;
      if (d < firstDayOfWeek) {
        d += 7;
      }
      weekday = weekday != null ? 1 * weekday : firstDayOfWeek;
      dayOfYear = 1 + week1Jan + 7 * (week - 1) - d + weekday;
      return {
        year: dayOfYear > 0 ? year : year - 1,
        dayOfYear: dayOfYear > 0 ? dayOfYear : daysInYear(year - 1) + dayOfYear
      };
    }
    function getSetDayOfYear(input) {
      var dayOfYear = Math.round((this.clone().startOf('day') - this.clone().startOf('year')) / 864e5) + 1;
      return input == null ? dayOfYear : this.add((input - dayOfYear), 'd');
    }
    function defaults(a, b, c) {
      if (a != null) {
        return a;
      }
      if (b != null) {
        return b;
      }
      return c;
    }
    function currentDateArray(config) {
      var now = new Date();
      if (config._useUTC) {
        return [now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()];
      }
      return [now.getFullYear(), now.getMonth(), now.getDate()];
    }
    function configFromArray(config) {
      var i,
          date,
          input = [],
          currentDate,
          yearToUse;
      if (config._d) {
        return;
      }
      currentDate = currentDateArray(config);
      if (config._w && config._a[DATE] == null && config._a[MONTH] == null) {
        dayOfYearFromWeekInfo(config);
      }
      if (config._dayOfYear) {
        yearToUse = defaults(config._a[YEAR], currentDate[YEAR]);
        if (config._dayOfYear > daysInYear(yearToUse)) {
          getParsingFlags(config)._overflowDayOfYear = true;
        }
        date = createUTCDate(yearToUse, 0, config._dayOfYear);
        config._a[MONTH] = date.getUTCMonth();
        config._a[DATE] = date.getUTCDate();
      }
      for (i = 0; i < 3 && config._a[i] == null; ++i) {
        config._a[i] = input[i] = currentDate[i];
      }
      for (; i < 7; i++) {
        config._a[i] = input[i] = (config._a[i] == null) ? (i === 2 ? 1 : 0) : config._a[i];
      }
      if (config._a[HOUR] === 24 && config._a[MINUTE] === 0 && config._a[SECOND] === 0 && config._a[MILLISECOND] === 0) {
        config._nextDay = true;
        config._a[HOUR] = 0;
      }
      config._d = (config._useUTC ? createUTCDate : createDate).apply(null, input);
      if (config._tzm != null) {
        config._d.setUTCMinutes(config._d.getUTCMinutes() - config._tzm);
      }
      if (config._nextDay) {
        config._a[HOUR] = 24;
      }
    }
    function dayOfYearFromWeekInfo(config) {
      var w,
          weekYear,
          week,
          weekday,
          dow,
          doy,
          temp;
      w = config._w;
      if (w.GG != null || w.W != null || w.E != null) {
        dow = 1;
        doy = 4;
        weekYear = defaults(w.GG, config._a[YEAR], weekOfYear(local__createLocal(), 1, 4).year);
        week = defaults(w.W, 1);
        weekday = defaults(w.E, 1);
      } else {
        dow = config._locale._week.dow;
        doy = config._locale._week.doy;
        weekYear = defaults(w.gg, config._a[YEAR], weekOfYear(local__createLocal(), dow, doy).year);
        week = defaults(w.w, 1);
        if (w.d != null) {
          weekday = w.d;
          if (weekday < dow) {
            ++week;
          }
        } else if (w.e != null) {
          weekday = w.e + dow;
        } else {
          weekday = dow;
        }
      }
      temp = dayOfYearFromWeeks(weekYear, week, weekday, doy, dow);
      config._a[YEAR] = temp.year;
      config._dayOfYear = temp.dayOfYear;
    }
    utils_hooks__hooks.ISO_8601 = function() {};
    function configFromStringAndFormat(config) {
      if (config._f === utils_hooks__hooks.ISO_8601) {
        configFromISO(config);
        return;
      }
      config._a = [];
      getParsingFlags(config).empty = true;
      var string = '' + config._i,
          i,
          parsedInput,
          tokens,
          token,
          skipped,
          stringLength = string.length,
          totalParsedInputLength = 0;
      tokens = expandFormat(config._f, config._locale).match(formattingTokens) || [];
      for (i = 0; i < tokens.length; i++) {
        token = tokens[i];
        parsedInput = (string.match(getParseRegexForToken(token, config)) || [])[0];
        if (parsedInput) {
          skipped = string.substr(0, string.indexOf(parsedInput));
          if (skipped.length > 0) {
            getParsingFlags(config).unusedInput.push(skipped);
          }
          string = string.slice(string.indexOf(parsedInput) + parsedInput.length);
          totalParsedInputLength += parsedInput.length;
        }
        if (formatTokenFunctions[token]) {
          if (parsedInput) {
            getParsingFlags(config).empty = false;
          } else {
            getParsingFlags(config).unusedTokens.push(token);
          }
          addTimeToArrayFromToken(token, parsedInput, config);
        } else if (config._strict && !parsedInput) {
          getParsingFlags(config).unusedTokens.push(token);
        }
      }
      getParsingFlags(config).charsLeftOver = stringLength - totalParsedInputLength;
      if (string.length > 0) {
        getParsingFlags(config).unusedInput.push(string);
      }
      if (getParsingFlags(config).bigHour === true && config._a[HOUR] <= 12 && config._a[HOUR] > 0) {
        getParsingFlags(config).bigHour = undefined;
      }
      config._a[HOUR] = meridiemFixWrap(config._locale, config._a[HOUR], config._meridiem);
      configFromArray(config);
      checkOverflow(config);
    }
    function meridiemFixWrap(locale, hour, meridiem) {
      var isPm;
      if (meridiem == null) {
        return hour;
      }
      if (locale.meridiemHour != null) {
        return locale.meridiemHour(hour, meridiem);
      } else if (locale.isPM != null) {
        isPm = locale.isPM(meridiem);
        if (isPm && hour < 12) {
          hour += 12;
        }
        if (!isPm && hour === 12) {
          hour = 0;
        }
        return hour;
      } else {
        return hour;
      }
    }
    function configFromStringAndArray(config) {
      var tempConfig,
          bestMoment,
          scoreToBeat,
          i,
          currentScore;
      if (config._f.length === 0) {
        getParsingFlags(config).invalidFormat = true;
        config._d = new Date(NaN);
        return;
      }
      for (i = 0; i < config._f.length; i++) {
        currentScore = 0;
        tempConfig = copyConfig({}, config);
        if (config._useUTC != null) {
          tempConfig._useUTC = config._useUTC;
        }
        tempConfig._f = config._f[i];
        configFromStringAndFormat(tempConfig);
        if (!valid__isValid(tempConfig)) {
          continue;
        }
        currentScore += getParsingFlags(tempConfig).charsLeftOver;
        currentScore += getParsingFlags(tempConfig).unusedTokens.length * 10;
        getParsingFlags(tempConfig).score = currentScore;
        if (scoreToBeat == null || currentScore < scoreToBeat) {
          scoreToBeat = currentScore;
          bestMoment = tempConfig;
        }
      }
      extend(config, bestMoment || tempConfig);
    }
    function configFromObject(config) {
      if (config._d) {
        return;
      }
      var i = normalizeObjectUnits(config._i);
      config._a = [i.year, i.month, i.day || i.date, i.hour, i.minute, i.second, i.millisecond];
      configFromArray(config);
    }
    function createFromConfig(config) {
      var res = new Moment(checkOverflow(prepareConfig(config)));
      if (res._nextDay) {
        res.add(1, 'd');
        res._nextDay = undefined;
      }
      return res;
    }
    function prepareConfig(config) {
      var input = config._i,
          format = config._f;
      config._locale = config._locale || locale_locales__getLocale(config._l);
      if (input === null || (format === undefined && input === '')) {
        return valid__createInvalid({nullInput: true});
      }
      if (typeof input === 'string') {
        config._i = input = config._locale.preparse(input);
      }
      if (isMoment(input)) {
        return new Moment(checkOverflow(input));
      } else if (isArray(format)) {
        configFromStringAndArray(config);
      } else if (format) {
        configFromStringAndFormat(config);
      } else if (isDate(input)) {
        config._d = input;
      } else {
        configFromInput(config);
      }
      return config;
    }
    function configFromInput(config) {
      var input = config._i;
      if (input === undefined) {
        config._d = new Date();
      } else if (isDate(input)) {
        config._d = new Date(+input);
      } else if (typeof input === 'string') {
        configFromString(config);
      } else if (isArray(input)) {
        config._a = map(input.slice(0), function(obj) {
          return parseInt(obj, 10);
        });
        configFromArray(config);
      } else if (typeof(input) === 'object') {
        configFromObject(config);
      } else if (typeof(input) === 'number') {
        config._d = new Date(input);
      } else {
        utils_hooks__hooks.createFromInputFallback(config);
      }
    }
    function createLocalOrUTC(input, format, locale, strict, isUTC) {
      var c = {};
      if (typeof(locale) === 'boolean') {
        strict = locale;
        locale = undefined;
      }
      c._isAMomentObject = true;
      c._useUTC = c._isUTC = isUTC;
      c._l = locale;
      c._i = input;
      c._f = format;
      c._strict = strict;
      return createFromConfig(c);
    }
    function local__createLocal(input, format, locale, strict) {
      return createLocalOrUTC(input, format, locale, strict, false);
    }
    var prototypeMin = deprecate('moment().min is deprecated, use moment.min instead. https://github.com/moment/moment/issues/1548', function() {
      var other = local__createLocal.apply(null, arguments);
      return other < this ? this : other;
    });
    var prototypeMax = deprecate('moment().max is deprecated, use moment.max instead. https://github.com/moment/moment/issues/1548', function() {
      var other = local__createLocal.apply(null, arguments);
      return other > this ? this : other;
    });
    function pickBy(fn, moments) {
      var res,
          i;
      if (moments.length === 1 && isArray(moments[0])) {
        moments = moments[0];
      }
      if (!moments.length) {
        return local__createLocal();
      }
      res = moments[0];
      for (i = 1; i < moments.length; ++i) {
        if (!moments[i].isValid() || moments[i][fn](res)) {
          res = moments[i];
        }
      }
      return res;
    }
    function min() {
      var args = [].slice.call(arguments, 0);
      return pickBy('isBefore', args);
    }
    function max() {
      var args = [].slice.call(arguments, 0);
      return pickBy('isAfter', args);
    }
    function Duration(duration) {
      var normalizedInput = normalizeObjectUnits(duration),
          years = normalizedInput.year || 0,
          quarters = normalizedInput.quarter || 0,
          months = normalizedInput.month || 0,
          weeks = normalizedInput.week || 0,
          days = normalizedInput.day || 0,
          hours = normalizedInput.hour || 0,
          minutes = normalizedInput.minute || 0,
          seconds = normalizedInput.second || 0,
          milliseconds = normalizedInput.millisecond || 0;
      this._milliseconds = +milliseconds + seconds * 1e3 + minutes * 6e4 + hours * 36e5;
      this._days = +days + weeks * 7;
      this._months = +months + quarters * 3 + years * 12;
      this._data = {};
      this._locale = locale_locales__getLocale();
      this._bubble();
    }
    function isDuration(obj) {
      return obj instanceof Duration;
    }
    function offset(token, separator) {
      addFormatToken(token, 0, 0, function() {
        var offset = this.utcOffset();
        var sign = '+';
        if (offset < 0) {
          offset = -offset;
          sign = '-';
        }
        return sign + zeroFill(~~(offset / 60), 2) + separator + zeroFill(~~(offset) % 60, 2);
      });
    }
    offset('Z', ':');
    offset('ZZ', '');
    addRegexToken('Z', matchOffset);
    addRegexToken('ZZ', matchOffset);
    addParseToken(['Z', 'ZZ'], function(input, array, config) {
      config._useUTC = true;
      config._tzm = offsetFromString(input);
    });
    var chunkOffset = /([\+\-]|\d\d)/gi;
    function offsetFromString(string) {
      var matches = ((string || '').match(matchOffset) || []);
      var chunk = matches[matches.length - 1] || [];
      var parts = (chunk + '').match(chunkOffset) || ['-', 0, 0];
      var minutes = +(parts[1] * 60) + toInt(parts[2]);
      return parts[0] === '+' ? minutes : -minutes;
    }
    function cloneWithOffset(input, model) {
      var res,
          diff;
      if (model._isUTC) {
        res = model.clone();
        diff = (isMoment(input) || isDate(input) ? +input : +local__createLocal(input)) - (+res);
        res._d.setTime(+res._d + diff);
        utils_hooks__hooks.updateOffset(res, false);
        return res;
      } else {
        return local__createLocal(input).local();
      }
    }
    function getDateOffset(m) {
      return -Math.round(m._d.getTimezoneOffset() / 15) * 15;
    }
    utils_hooks__hooks.updateOffset = function() {};
    function getSetOffset(input, keepLocalTime) {
      var offset = this._offset || 0,
          localAdjust;
      if (input != null) {
        if (typeof input === 'string') {
          input = offsetFromString(input);
        }
        if (Math.abs(input) < 16) {
          input = input * 60;
        }
        if (!this._isUTC && keepLocalTime) {
          localAdjust = getDateOffset(this);
        }
        this._offset = input;
        this._isUTC = true;
        if (localAdjust != null) {
          this.add(localAdjust, 'm');
        }
        if (offset !== input) {
          if (!keepLocalTime || this._changeInProgress) {
            add_subtract__addSubtract(this, create__createDuration(input - offset, 'm'), 1, false);
          } else if (!this._changeInProgress) {
            this._changeInProgress = true;
            utils_hooks__hooks.updateOffset(this, true);
            this._changeInProgress = null;
          }
        }
        return this;
      } else {
        return this._isUTC ? offset : getDateOffset(this);
      }
    }
    function getSetZone(input, keepLocalTime) {
      if (input != null) {
        if (typeof input !== 'string') {
          input = -input;
        }
        this.utcOffset(input, keepLocalTime);
        return this;
      } else {
        return -this.utcOffset();
      }
    }
    function setOffsetToUTC(keepLocalTime) {
      return this.utcOffset(0, keepLocalTime);
    }
    function setOffsetToLocal(keepLocalTime) {
      if (this._isUTC) {
        this.utcOffset(0, keepLocalTime);
        this._isUTC = false;
        if (keepLocalTime) {
          this.subtract(getDateOffset(this), 'm');
        }
      }
      return this;
    }
    function setOffsetToParsedOffset() {
      if (this._tzm) {
        this.utcOffset(this._tzm);
      } else if (typeof this._i === 'string') {
        this.utcOffset(offsetFromString(this._i));
      }
      return this;
    }
    function hasAlignedHourOffset(input) {
      input = input ? local__createLocal(input).utcOffset() : 0;
      return (this.utcOffset() - input) % 60 === 0;
    }
    function isDaylightSavingTime() {
      return (this.utcOffset() > this.clone().month(0).utcOffset() || this.utcOffset() > this.clone().month(5).utcOffset());
    }
    function isDaylightSavingTimeShifted() {
      if (typeof this._isDSTShifted !== 'undefined') {
        return this._isDSTShifted;
      }
      var c = {};
      copyConfig(c, this);
      c = prepareConfig(c);
      if (c._a) {
        var other = c._isUTC ? create_utc__createUTC(c._a) : local__createLocal(c._a);
        this._isDSTShifted = this.isValid() && compareArrays(c._a, other.toArray()) > 0;
      } else {
        this._isDSTShifted = false;
      }
      return this._isDSTShifted;
    }
    function isLocal() {
      return !this._isUTC;
    }
    function isUtcOffset() {
      return this._isUTC;
    }
    function isUtc() {
      return this._isUTC && this._offset === 0;
    }
    var aspNetRegex = /(\-)?(?:(\d*)\.)?(\d+)\:(\d+)(?:\:(\d+)\.?(\d{3})?)?/;
    var create__isoRegex = /^(-)?P(?:(?:([0-9,.]*)Y)?(?:([0-9,.]*)M)?(?:([0-9,.]*)D)?(?:T(?:([0-9,.]*)H)?(?:([0-9,.]*)M)?(?:([0-9,.]*)S)?)?|([0-9,.]*)W)$/;
    function create__createDuration(input, key) {
      var duration = input,
          match = null,
          sign,
          ret,
          diffRes;
      if (isDuration(input)) {
        duration = {
          ms: input._milliseconds,
          d: input._days,
          M: input._months
        };
      } else if (typeof input === 'number') {
        duration = {};
        if (key) {
          duration[key] = input;
        } else {
          duration.milliseconds = input;
        }
      } else if (!!(match = aspNetRegex.exec(input))) {
        sign = (match[1] === '-') ? -1 : 1;
        duration = {
          y: 0,
          d: toInt(match[DATE]) * sign,
          h: toInt(match[HOUR]) * sign,
          m: toInt(match[MINUTE]) * sign,
          s: toInt(match[SECOND]) * sign,
          ms: toInt(match[MILLISECOND]) * sign
        };
      } else if (!!(match = create__isoRegex.exec(input))) {
        sign = (match[1] === '-') ? -1 : 1;
        duration = {
          y: parseIso(match[2], sign),
          M: parseIso(match[3], sign),
          d: parseIso(match[4], sign),
          h: parseIso(match[5], sign),
          m: parseIso(match[6], sign),
          s: parseIso(match[7], sign),
          w: parseIso(match[8], sign)
        };
      } else if (duration == null) {
        duration = {};
      } else if (typeof duration === 'object' && ('from' in duration || 'to' in duration)) {
        diffRes = momentsDifference(local__createLocal(duration.from), local__createLocal(duration.to));
        duration = {};
        duration.ms = diffRes.milliseconds;
        duration.M = diffRes.months;
      }
      ret = new Duration(duration);
      if (isDuration(input) && hasOwnProp(input, '_locale')) {
        ret._locale = input._locale;
      }
      return ret;
    }
    create__createDuration.fn = Duration.prototype;
    function parseIso(inp, sign) {
      var res = inp && parseFloat(inp.replace(',', '.'));
      return (isNaN(res) ? 0 : res) * sign;
    }
    function positiveMomentsDifference(base, other) {
      var res = {
        milliseconds: 0,
        months: 0
      };
      res.months = other.month() - base.month() + (other.year() - base.year()) * 12;
      if (base.clone().add(res.months, 'M').isAfter(other)) {
        --res.months;
      }
      res.milliseconds = +other - +(base.clone().add(res.months, 'M'));
      return res;
    }
    function momentsDifference(base, other) {
      var res;
      other = cloneWithOffset(other, base);
      if (base.isBefore(other)) {
        res = positiveMomentsDifference(base, other);
      } else {
        res = positiveMomentsDifference(other, base);
        res.milliseconds = -res.milliseconds;
        res.months = -res.months;
      }
      return res;
    }
    function createAdder(direction, name) {
      return function(val, period) {
        var dur,
            tmp;
        if (period !== null && !isNaN(+period)) {
          deprecateSimple(name, 'moment().' + name + '(period, number) is deprecated. Please use moment().' + name + '(number, period).');
          tmp = val;
          val = period;
          period = tmp;
        }
        val = typeof val === 'string' ? +val : val;
        dur = create__createDuration(val, period);
        add_subtract__addSubtract(this, dur, direction);
        return this;
      };
    }
    function add_subtract__addSubtract(mom, duration, isAdding, updateOffset) {
      var milliseconds = duration._milliseconds,
          days = duration._days,
          months = duration._months;
      updateOffset = updateOffset == null ? true : updateOffset;
      if (milliseconds) {
        mom._d.setTime(+mom._d + milliseconds * isAdding);
      }
      if (days) {
        get_set__set(mom, 'Date', get_set__get(mom, 'Date') + days * isAdding);
      }
      if (months) {
        setMonth(mom, get_set__get(mom, 'Month') + months * isAdding);
      }
      if (updateOffset) {
        utils_hooks__hooks.updateOffset(mom, days || months);
      }
    }
    var add_subtract__add = createAdder(1, 'add');
    var add_subtract__subtract = createAdder(-1, 'subtract');
    function moment_calendar__calendar(time, formats) {
      var now = time || local__createLocal(),
          sod = cloneWithOffset(now, this).startOf('day'),
          diff = this.diff(sod, 'days', true),
          format = diff < -6 ? 'sameElse' : diff < -1 ? 'lastWeek' : diff < 0 ? 'lastDay' : diff < 1 ? 'sameDay' : diff < 2 ? 'nextDay' : diff < 7 ? 'nextWeek' : 'sameElse';
      return this.format(formats && formats[format] || this.localeData().calendar(format, this, local__createLocal(now)));
    }
    function clone() {
      return new Moment(this);
    }
    function isAfter(input, units) {
      var inputMs;
      units = normalizeUnits(typeof units !== 'undefined' ? units : 'millisecond');
      if (units === 'millisecond') {
        input = isMoment(input) ? input : local__createLocal(input);
        return +this > +input;
      } else {
        inputMs = isMoment(input) ? +input : +local__createLocal(input);
        return inputMs < +this.clone().startOf(units);
      }
    }
    function isBefore(input, units) {
      var inputMs;
      units = normalizeUnits(typeof units !== 'undefined' ? units : 'millisecond');
      if (units === 'millisecond') {
        input = isMoment(input) ? input : local__createLocal(input);
        return +this < +input;
      } else {
        inputMs = isMoment(input) ? +input : +local__createLocal(input);
        return +this.clone().endOf(units) < inputMs;
      }
    }
    function isBetween(from, to, units) {
      return this.isAfter(from, units) && this.isBefore(to, units);
    }
    function isSame(input, units) {
      var inputMs;
      units = normalizeUnits(units || 'millisecond');
      if (units === 'millisecond') {
        input = isMoment(input) ? input : local__createLocal(input);
        return +this === +input;
      } else {
        inputMs = +local__createLocal(input);
        return +(this.clone().startOf(units)) <= inputMs && inputMs <= +(this.clone().endOf(units));
      }
    }
    function diff(input, units, asFloat) {
      var that = cloneWithOffset(input, this),
          zoneDelta = (that.utcOffset() - this.utcOffset()) * 6e4,
          delta,
          output;
      units = normalizeUnits(units);
      if (units === 'year' || units === 'month' || units === 'quarter') {
        output = monthDiff(this, that);
        if (units === 'quarter') {
          output = output / 3;
        } else if (units === 'year') {
          output = output / 12;
        }
      } else {
        delta = this - that;
        output = units === 'second' ? delta / 1e3 : units === 'minute' ? delta / 6e4 : units === 'hour' ? delta / 36e5 : units === 'day' ? (delta - zoneDelta) / 864e5 : units === 'week' ? (delta - zoneDelta) / 6048e5 : delta;
      }
      return asFloat ? output : absFloor(output);
    }
    function monthDiff(a, b) {
      var wholeMonthDiff = ((b.year() - a.year()) * 12) + (b.month() - a.month()),
          anchor = a.clone().add(wholeMonthDiff, 'months'),
          anchor2,
          adjust;
      if (b - anchor < 0) {
        anchor2 = a.clone().add(wholeMonthDiff - 1, 'months');
        adjust = (b - anchor) / (anchor - anchor2);
      } else {
        anchor2 = a.clone().add(wholeMonthDiff + 1, 'months');
        adjust = (b - anchor) / (anchor2 - anchor);
      }
      return -(wholeMonthDiff + adjust);
    }
    utils_hooks__hooks.defaultFormat = 'YYYY-MM-DDTHH:mm:ssZ';
    function toString() {
      return this.clone().locale('en').format('ddd MMM DD YYYY HH:mm:ss [GMT]ZZ');
    }
    function moment_format__toISOString() {
      var m = this.clone().utc();
      if (0 < m.year() && m.year() <= 9999) {
        if ('function' === typeof Date.prototype.toISOString) {
          return this.toDate().toISOString();
        } else {
          return formatMoment(m, 'YYYY-MM-DD[T]HH:mm:ss.SSS[Z]');
        }
      } else {
        return formatMoment(m, 'YYYYYY-MM-DD[T]HH:mm:ss.SSS[Z]');
      }
    }
    function format(inputString) {
      var output = formatMoment(this, inputString || utils_hooks__hooks.defaultFormat);
      return this.localeData().postformat(output);
    }
    function from(time, withoutSuffix) {
      if (!this.isValid()) {
        return this.localeData().invalidDate();
      }
      return create__createDuration({
        to: this,
        from: time
      }).locale(this.locale()).humanize(!withoutSuffix);
    }
    function fromNow(withoutSuffix) {
      return this.from(local__createLocal(), withoutSuffix);
    }
    function to(time, withoutSuffix) {
      if (!this.isValid()) {
        return this.localeData().invalidDate();
      }
      return create__createDuration({
        from: this,
        to: time
      }).locale(this.locale()).humanize(!withoutSuffix);
    }
    function toNow(withoutSuffix) {
      return this.to(local__createLocal(), withoutSuffix);
    }
    function locale(key) {
      var newLocaleData;
      if (key === undefined) {
        return this._locale._abbr;
      } else {
        newLocaleData = locale_locales__getLocale(key);
        if (newLocaleData != null) {
          this._locale = newLocaleData;
        }
        return this;
      }
    }
    var lang = deprecate('moment().lang() is deprecated. Instead, use moment().localeData() to get the language configuration. Use moment().locale() to change languages.', function(key) {
      if (key === undefined) {
        return this.localeData();
      } else {
        return this.locale(key);
      }
    });
    function localeData() {
      return this._locale;
    }
    function startOf(units) {
      units = normalizeUnits(units);
      switch (units) {
        case 'year':
          this.month(0);
        case 'quarter':
        case 'month':
          this.date(1);
        case 'week':
        case 'isoWeek':
        case 'day':
          this.hours(0);
        case 'hour':
          this.minutes(0);
        case 'minute':
          this.seconds(0);
        case 'second':
          this.milliseconds(0);
      }
      if (units === 'week') {
        this.weekday(0);
      }
      if (units === 'isoWeek') {
        this.isoWeekday(1);
      }
      if (units === 'quarter') {
        this.month(Math.floor(this.month() / 3) * 3);
      }
      return this;
    }
    function endOf(units) {
      units = normalizeUnits(units);
      if (units === undefined || units === 'millisecond') {
        return this;
      }
      return this.startOf(units).add(1, (units === 'isoWeek' ? 'week' : units)).subtract(1, 'ms');
    }
    function to_type__valueOf() {
      return +this._d - ((this._offset || 0) * 60000);
    }
    function unix() {
      return Math.floor(+this / 1000);
    }
    function toDate() {
      return this._offset ? new Date(+this) : this._d;
    }
    function toArray() {
      var m = this;
      return [m.year(), m.month(), m.date(), m.hour(), m.minute(), m.second(), m.millisecond()];
    }
    function toObject() {
      var m = this;
      return {
        years: m.year(),
        months: m.month(),
        date: m.date(),
        hours: m.hours(),
        minutes: m.minutes(),
        seconds: m.seconds(),
        milliseconds: m.milliseconds()
      };
    }
    function moment_valid__isValid() {
      return valid__isValid(this);
    }
    function parsingFlags() {
      return extend({}, getParsingFlags(this));
    }
    function invalidAt() {
      return getParsingFlags(this).overflow;
    }
    addFormatToken(0, ['gg', 2], 0, function() {
      return this.weekYear() % 100;
    });
    addFormatToken(0, ['GG', 2], 0, function() {
      return this.isoWeekYear() % 100;
    });
    function addWeekYearFormatToken(token, getter) {
      addFormatToken(0, [token, token.length], 0, getter);
    }
    addWeekYearFormatToken('gggg', 'weekYear');
    addWeekYearFormatToken('ggggg', 'weekYear');
    addWeekYearFormatToken('GGGG', 'isoWeekYear');
    addWeekYearFormatToken('GGGGG', 'isoWeekYear');
    addUnitAlias('weekYear', 'gg');
    addUnitAlias('isoWeekYear', 'GG');
    addRegexToken('G', matchSigned);
    addRegexToken('g', matchSigned);
    addRegexToken('GG', match1to2, match2);
    addRegexToken('gg', match1to2, match2);
    addRegexToken('GGGG', match1to4, match4);
    addRegexToken('gggg', match1to4, match4);
    addRegexToken('GGGGG', match1to6, match6);
    addRegexToken('ggggg', match1to6, match6);
    addWeekParseToken(['gggg', 'ggggg', 'GGGG', 'GGGGG'], function(input, week, config, token) {
      week[token.substr(0, 2)] = toInt(input);
    });
    addWeekParseToken(['gg', 'GG'], function(input, week, config, token) {
      week[token] = utils_hooks__hooks.parseTwoDigitYear(input);
    });
    function weeksInYear(year, dow, doy) {
      return weekOfYear(local__createLocal([year, 11, 31 + dow - doy]), dow, doy).week;
    }
    function getSetWeekYear(input) {
      var year = weekOfYear(this, this.localeData()._week.dow, this.localeData()._week.doy).year;
      return input == null ? year : this.add((input - year), 'y');
    }
    function getSetISOWeekYear(input) {
      var year = weekOfYear(this, 1, 4).year;
      return input == null ? year : this.add((input - year), 'y');
    }
    function getISOWeeksInYear() {
      return weeksInYear(this.year(), 1, 4);
    }
    function getWeeksInYear() {
      var weekInfo = this.localeData()._week;
      return weeksInYear(this.year(), weekInfo.dow, weekInfo.doy);
    }
    addFormatToken('Q', 0, 0, 'quarter');
    addUnitAlias('quarter', 'Q');
    addRegexToken('Q', match1);
    addParseToken('Q', function(input, array) {
      array[MONTH] = (toInt(input) - 1) * 3;
    });
    function getSetQuarter(input) {
      return input == null ? Math.ceil((this.month() + 1) / 3) : this.month((input - 1) * 3 + this.month() % 3);
    }
    addFormatToken('D', ['DD', 2], 'Do', 'date');
    addUnitAlias('date', 'D');
    addRegexToken('D', match1to2);
    addRegexToken('DD', match1to2, match2);
    addRegexToken('Do', function(isStrict, locale) {
      return isStrict ? locale._ordinalParse : locale._ordinalParseLenient;
    });
    addParseToken(['D', 'DD'], DATE);
    addParseToken('Do', function(input, array) {
      array[DATE] = toInt(input.match(match1to2)[0], 10);
    });
    var getSetDayOfMonth = makeGetSet('Date', true);
    addFormatToken('d', 0, 'do', 'day');
    addFormatToken('dd', 0, 0, function(format) {
      return this.localeData().weekdaysMin(this, format);
    });
    addFormatToken('ddd', 0, 0, function(format) {
      return this.localeData().weekdaysShort(this, format);
    });
    addFormatToken('dddd', 0, 0, function(format) {
      return this.localeData().weekdays(this, format);
    });
    addFormatToken('e', 0, 0, 'weekday');
    addFormatToken('E', 0, 0, 'isoWeekday');
    addUnitAlias('day', 'd');
    addUnitAlias('weekday', 'e');
    addUnitAlias('isoWeekday', 'E');
    addRegexToken('d', match1to2);
    addRegexToken('e', match1to2);
    addRegexToken('E', match1to2);
    addRegexToken('dd', matchWord);
    addRegexToken('ddd', matchWord);
    addRegexToken('dddd', matchWord);
    addWeekParseToken(['dd', 'ddd', 'dddd'], function(input, week, config) {
      var weekday = config._locale.weekdaysParse(input);
      if (weekday != null) {
        week.d = weekday;
      } else {
        getParsingFlags(config).invalidWeekday = input;
      }
    });
    addWeekParseToken(['d', 'e', 'E'], function(input, week, config, token) {
      week[token] = toInt(input);
    });
    function parseWeekday(input, locale) {
      if (typeof input !== 'string') {
        return input;
      }
      if (!isNaN(input)) {
        return parseInt(input, 10);
      }
      input = locale.weekdaysParse(input);
      if (typeof input === 'number') {
        return input;
      }
      return null;
    }
    var defaultLocaleWeekdays = 'Sunday_Monday_Tuesday_Wednesday_Thursday_Friday_Saturday'.split('_');
    function localeWeekdays(m) {
      return this._weekdays[m.day()];
    }
    var defaultLocaleWeekdaysShort = 'Sun_Mon_Tue_Wed_Thu_Fri_Sat'.split('_');
    function localeWeekdaysShort(m) {
      return this._weekdaysShort[m.day()];
    }
    var defaultLocaleWeekdaysMin = 'Su_Mo_Tu_We_Th_Fr_Sa'.split('_');
    function localeWeekdaysMin(m) {
      return this._weekdaysMin[m.day()];
    }
    function localeWeekdaysParse(weekdayName) {
      var i,
          mom,
          regex;
      this._weekdaysParse = this._weekdaysParse || [];
      for (i = 0; i < 7; i++) {
        if (!this._weekdaysParse[i]) {
          mom = local__createLocal([2000, 1]).day(i);
          regex = '^' + this.weekdays(mom, '') + '|^' + this.weekdaysShort(mom, '') + '|^' + this.weekdaysMin(mom, '');
          this._weekdaysParse[i] = new RegExp(regex.replace('.', ''), 'i');
        }
        if (this._weekdaysParse[i].test(weekdayName)) {
          return i;
        }
      }
    }
    function getSetDayOfWeek(input) {
      var day = this._isUTC ? this._d.getUTCDay() : this._d.getDay();
      if (input != null) {
        input = parseWeekday(input, this.localeData());
        return this.add(input - day, 'd');
      } else {
        return day;
      }
    }
    function getSetLocaleDayOfWeek(input) {
      var weekday = (this.day() + 7 - this.localeData()._week.dow) % 7;
      return input == null ? weekday : this.add(input - weekday, 'd');
    }
    function getSetISODayOfWeek(input) {
      return input == null ? this.day() || 7 : this.day(this.day() % 7 ? input : input - 7);
    }
    addFormatToken('H', ['HH', 2], 0, 'hour');
    addFormatToken('h', ['hh', 2], 0, function() {
      return this.hours() % 12 || 12;
    });
    function meridiem(token, lowercase) {
      addFormatToken(token, 0, 0, function() {
        return this.localeData().meridiem(this.hours(), this.minutes(), lowercase);
      });
    }
    meridiem('a', true);
    meridiem('A', false);
    addUnitAlias('hour', 'h');
    function matchMeridiem(isStrict, locale) {
      return locale._meridiemParse;
    }
    addRegexToken('a', matchMeridiem);
    addRegexToken('A', matchMeridiem);
    addRegexToken('H', match1to2);
    addRegexToken('h', match1to2);
    addRegexToken('HH', match1to2, match2);
    addRegexToken('hh', match1to2, match2);
    addParseToken(['H', 'HH'], HOUR);
    addParseToken(['a', 'A'], function(input, array, config) {
      config._isPm = config._locale.isPM(input);
      config._meridiem = input;
    });
    addParseToken(['h', 'hh'], function(input, array, config) {
      array[HOUR] = toInt(input);
      getParsingFlags(config).bigHour = true;
    });
    function localeIsPM(input) {
      return ((input + '').toLowerCase().charAt(0) === 'p');
    }
    var defaultLocaleMeridiemParse = /[ap]\.?m?\.?/i;
    function localeMeridiem(hours, minutes, isLower) {
      if (hours > 11) {
        return isLower ? 'pm' : 'PM';
      } else {
        return isLower ? 'am' : 'AM';
      }
    }
    var getSetHour = makeGetSet('Hours', true);
    addFormatToken('m', ['mm', 2], 0, 'minute');
    addUnitAlias('minute', 'm');
    addRegexToken('m', match1to2);
    addRegexToken('mm', match1to2, match2);
    addParseToken(['m', 'mm'], MINUTE);
    var getSetMinute = makeGetSet('Minutes', false);
    addFormatToken('s', ['ss', 2], 0, 'second');
    addUnitAlias('second', 's');
    addRegexToken('s', match1to2);
    addRegexToken('ss', match1to2, match2);
    addParseToken(['s', 'ss'], SECOND);
    var getSetSecond = makeGetSet('Seconds', false);
    addFormatToken('S', 0, 0, function() {
      return ~~(this.millisecond() / 100);
    });
    addFormatToken(0, ['SS', 2], 0, function() {
      return ~~(this.millisecond() / 10);
    });
    addFormatToken(0, ['SSS', 3], 0, 'millisecond');
    addFormatToken(0, ['SSSS', 4], 0, function() {
      return this.millisecond() * 10;
    });
    addFormatToken(0, ['SSSSS', 5], 0, function() {
      return this.millisecond() * 100;
    });
    addFormatToken(0, ['SSSSSS', 6], 0, function() {
      return this.millisecond() * 1000;
    });
    addFormatToken(0, ['SSSSSSS', 7], 0, function() {
      return this.millisecond() * 10000;
    });
    addFormatToken(0, ['SSSSSSSS', 8], 0, function() {
      return this.millisecond() * 100000;
    });
    addFormatToken(0, ['SSSSSSSSS', 9], 0, function() {
      return this.millisecond() * 1000000;
    });
    addUnitAlias('millisecond', 'ms');
    addRegexToken('S', match1to3, match1);
    addRegexToken('SS', match1to3, match2);
    addRegexToken('SSS', match1to3, match3);
    var token;
    for (token = 'SSSS'; token.length <= 9; token += 'S') {
      addRegexToken(token, matchUnsigned);
    }
    function parseMs(input, array) {
      array[MILLISECOND] = toInt(('0.' + input) * 1000);
    }
    for (token = 'S'; token.length <= 9; token += 'S') {
      addParseToken(token, parseMs);
    }
    var getSetMillisecond = makeGetSet('Milliseconds', false);
    addFormatToken('z', 0, 0, 'zoneAbbr');
    addFormatToken('zz', 0, 0, 'zoneName');
    function getZoneAbbr() {
      return this._isUTC ? 'UTC' : '';
    }
    function getZoneName() {
      return this._isUTC ? 'Coordinated Universal Time' : '';
    }
    var momentPrototype__proto = Moment.prototype;
    momentPrototype__proto.add = add_subtract__add;
    momentPrototype__proto.calendar = moment_calendar__calendar;
    momentPrototype__proto.clone = clone;
    momentPrototype__proto.diff = diff;
    momentPrototype__proto.endOf = endOf;
    momentPrototype__proto.format = format;
    momentPrototype__proto.from = from;
    momentPrototype__proto.fromNow = fromNow;
    momentPrototype__proto.to = to;
    momentPrototype__proto.toNow = toNow;
    momentPrototype__proto.get = getSet;
    momentPrototype__proto.invalidAt = invalidAt;
    momentPrototype__proto.isAfter = isAfter;
    momentPrototype__proto.isBefore = isBefore;
    momentPrototype__proto.isBetween = isBetween;
    momentPrototype__proto.isSame = isSame;
    momentPrototype__proto.isValid = moment_valid__isValid;
    momentPrototype__proto.lang = lang;
    momentPrototype__proto.locale = locale;
    momentPrototype__proto.localeData = localeData;
    momentPrototype__proto.max = prototypeMax;
    momentPrototype__proto.min = prototypeMin;
    momentPrototype__proto.parsingFlags = parsingFlags;
    momentPrototype__proto.set = getSet;
    momentPrototype__proto.startOf = startOf;
    momentPrototype__proto.subtract = add_subtract__subtract;
    momentPrototype__proto.toArray = toArray;
    momentPrototype__proto.toObject = toObject;
    momentPrototype__proto.toDate = toDate;
    momentPrototype__proto.toISOString = moment_format__toISOString;
    momentPrototype__proto.toJSON = moment_format__toISOString;
    momentPrototype__proto.toString = toString;
    momentPrototype__proto.unix = unix;
    momentPrototype__proto.valueOf = to_type__valueOf;
    momentPrototype__proto.year = getSetYear;
    momentPrototype__proto.isLeapYear = getIsLeapYear;
    momentPrototype__proto.weekYear = getSetWeekYear;
    momentPrototype__proto.isoWeekYear = getSetISOWeekYear;
    momentPrototype__proto.quarter = momentPrototype__proto.quarters = getSetQuarter;
    momentPrototype__proto.month = getSetMonth;
    momentPrototype__proto.daysInMonth = getDaysInMonth;
    momentPrototype__proto.week = momentPrototype__proto.weeks = getSetWeek;
    momentPrototype__proto.isoWeek = momentPrototype__proto.isoWeeks = getSetISOWeek;
    momentPrototype__proto.weeksInYear = getWeeksInYear;
    momentPrototype__proto.isoWeeksInYear = getISOWeeksInYear;
    momentPrototype__proto.date = getSetDayOfMonth;
    momentPrototype__proto.day = momentPrototype__proto.days = getSetDayOfWeek;
    momentPrototype__proto.weekday = getSetLocaleDayOfWeek;
    momentPrototype__proto.isoWeekday = getSetISODayOfWeek;
    momentPrototype__proto.dayOfYear = getSetDayOfYear;
    momentPrototype__proto.hour = momentPrototype__proto.hours = getSetHour;
    momentPrototype__proto.minute = momentPrototype__proto.minutes = getSetMinute;
    momentPrototype__proto.second = momentPrototype__proto.seconds = getSetSecond;
    momentPrototype__proto.millisecond = momentPrototype__proto.milliseconds = getSetMillisecond;
    momentPrototype__proto.utcOffset = getSetOffset;
    momentPrototype__proto.utc = setOffsetToUTC;
    momentPrototype__proto.local = setOffsetToLocal;
    momentPrototype__proto.parseZone = setOffsetToParsedOffset;
    momentPrototype__proto.hasAlignedHourOffset = hasAlignedHourOffset;
    momentPrototype__proto.isDST = isDaylightSavingTime;
    momentPrototype__proto.isDSTShifted = isDaylightSavingTimeShifted;
    momentPrototype__proto.isLocal = isLocal;
    momentPrototype__proto.isUtcOffset = isUtcOffset;
    momentPrototype__proto.isUtc = isUtc;
    momentPrototype__proto.isUTC = isUtc;
    momentPrototype__proto.zoneAbbr = getZoneAbbr;
    momentPrototype__proto.zoneName = getZoneName;
    momentPrototype__proto.dates = deprecate('dates accessor is deprecated. Use date instead.', getSetDayOfMonth);
    momentPrototype__proto.months = deprecate('months accessor is deprecated. Use month instead', getSetMonth);
    momentPrototype__proto.years = deprecate('years accessor is deprecated. Use year instead', getSetYear);
    momentPrototype__proto.zone = deprecate('moment().zone is deprecated, use moment().utcOffset instead. https://github.com/moment/moment/issues/1779', getSetZone);
    var momentPrototype = momentPrototype__proto;
    function moment__createUnix(input) {
      return local__createLocal(input * 1000);
    }
    function moment__createInZone() {
      return local__createLocal.apply(null, arguments).parseZone();
    }
    var defaultCalendar = {
      sameDay: '[Today at] LT',
      nextDay: '[Tomorrow at] LT',
      nextWeek: 'dddd [at] LT',
      lastDay: '[Yesterday at] LT',
      lastWeek: '[Last] dddd [at] LT',
      sameElse: 'L'
    };
    function locale_calendar__calendar(key, mom, now) {
      var output = this._calendar[key];
      return typeof output === 'function' ? output.call(mom, now) : output;
    }
    var defaultLongDateFormat = {
      LTS: 'h:mm:ss A',
      LT: 'h:mm A',
      L: 'MM/DD/YYYY',
      LL: 'MMMM D, YYYY',
      LLL: 'MMMM D, YYYY h:mm A',
      LLLL: 'dddd, MMMM D, YYYY h:mm A'
    };
    function longDateFormat(key) {
      var format = this._longDateFormat[key],
          formatUpper = this._longDateFormat[key.toUpperCase()];
      if (format || !formatUpper) {
        return format;
      }
      this._longDateFormat[key] = formatUpper.replace(/MMMM|MM|DD|dddd/g, function(val) {
        return val.slice(1);
      });
      return this._longDateFormat[key];
    }
    var defaultInvalidDate = 'Invalid date';
    function invalidDate() {
      return this._invalidDate;
    }
    var defaultOrdinal = '%d';
    var defaultOrdinalParse = /\d{1,2}/;
    function ordinal(number) {
      return this._ordinal.replace('%d', number);
    }
    function preParsePostFormat(string) {
      return string;
    }
    var defaultRelativeTime = {
      future: 'in %s',
      past: '%s ago',
      s: 'a few seconds',
      m: 'a minute',
      mm: '%d minutes',
      h: 'an hour',
      hh: '%d hours',
      d: 'a day',
      dd: '%d days',
      M: 'a month',
      MM: '%d months',
      y: 'a year',
      yy: '%d years'
    };
    function relative__relativeTime(number, withoutSuffix, string, isFuture) {
      var output = this._relativeTime[string];
      return (typeof output === 'function') ? output(number, withoutSuffix, string, isFuture) : output.replace(/%d/i, number);
    }
    function pastFuture(diff, output) {
      var format = this._relativeTime[diff > 0 ? 'future' : 'past'];
      return typeof format === 'function' ? format(output) : format.replace(/%s/i, output);
    }
    function locale_set__set(config) {
      var prop,
          i;
      for (i in config) {
        prop = config[i];
        if (typeof prop === 'function') {
          this[i] = prop;
        } else {
          this['_' + i] = prop;
        }
      }
      this._ordinalParseLenient = new RegExp(this._ordinalParse.source + '|' + (/\d{1,2}/).source);
    }
    var prototype__proto = Locale.prototype;
    prototype__proto._calendar = defaultCalendar;
    prototype__proto.calendar = locale_calendar__calendar;
    prototype__proto._longDateFormat = defaultLongDateFormat;
    prototype__proto.longDateFormat = longDateFormat;
    prototype__proto._invalidDate = defaultInvalidDate;
    prototype__proto.invalidDate = invalidDate;
    prototype__proto._ordinal = defaultOrdinal;
    prototype__proto.ordinal = ordinal;
    prototype__proto._ordinalParse = defaultOrdinalParse;
    prototype__proto.preparse = preParsePostFormat;
    prototype__proto.postformat = preParsePostFormat;
    prototype__proto._relativeTime = defaultRelativeTime;
    prototype__proto.relativeTime = relative__relativeTime;
    prototype__proto.pastFuture = pastFuture;
    prototype__proto.set = locale_set__set;
    prototype__proto.months = localeMonths;
    prototype__proto._months = defaultLocaleMonths;
    prototype__proto.monthsShort = localeMonthsShort;
    prototype__proto._monthsShort = defaultLocaleMonthsShort;
    prototype__proto.monthsParse = localeMonthsParse;
    prototype__proto.week = localeWeek;
    prototype__proto._week = defaultLocaleWeek;
    prototype__proto.firstDayOfYear = localeFirstDayOfYear;
    prototype__proto.firstDayOfWeek = localeFirstDayOfWeek;
    prototype__proto.weekdays = localeWeekdays;
    prototype__proto._weekdays = defaultLocaleWeekdays;
    prototype__proto.weekdaysMin = localeWeekdaysMin;
    prototype__proto._weekdaysMin = defaultLocaleWeekdaysMin;
    prototype__proto.weekdaysShort = localeWeekdaysShort;
    prototype__proto._weekdaysShort = defaultLocaleWeekdaysShort;
    prototype__proto.weekdaysParse = localeWeekdaysParse;
    prototype__proto.isPM = localeIsPM;
    prototype__proto._meridiemParse = defaultLocaleMeridiemParse;
    prototype__proto.meridiem = localeMeridiem;
    function lists__get(format, index, field, setter) {
      var locale = locale_locales__getLocale();
      var utc = create_utc__createUTC().set(setter, index);
      return locale[field](utc, format);
    }
    function list(format, index, field, count, setter) {
      if (typeof format === 'number') {
        index = format;
        format = undefined;
      }
      format = format || '';
      if (index != null) {
        return lists__get(format, index, field, setter);
      }
      var i;
      var out = [];
      for (i = 0; i < count; i++) {
        out[i] = lists__get(format, i, field, setter);
      }
      return out;
    }
    function lists__listMonths(format, index) {
      return list(format, index, 'months', 12, 'month');
    }
    function lists__listMonthsShort(format, index) {
      return list(format, index, 'monthsShort', 12, 'month');
    }
    function lists__listWeekdays(format, index) {
      return list(format, index, 'weekdays', 7, 'day');
    }
    function lists__listWeekdaysShort(format, index) {
      return list(format, index, 'weekdaysShort', 7, 'day');
    }
    function lists__listWeekdaysMin(format, index) {
      return list(format, index, 'weekdaysMin', 7, 'day');
    }
    locale_locales__getSetGlobalLocale('en', {
      ordinalParse: /\d{1,2}(th|st|nd|rd)/,
      ordinal: function(number) {
        var b = number % 10,
            output = (toInt(number % 100 / 10) === 1) ? 'th' : (b === 1) ? 'st' : (b === 2) ? 'nd' : (b === 3) ? 'rd' : 'th';
        return number + output;
      }
    });
    utils_hooks__hooks.lang = deprecate('moment.lang is deprecated. Use moment.locale instead.', locale_locales__getSetGlobalLocale);
    utils_hooks__hooks.langData = deprecate('moment.langData is deprecated. Use moment.localeData instead.', locale_locales__getLocale);
    var mathAbs = Math.abs;
    function duration_abs__abs() {
      var data = this._data;
      this._milliseconds = mathAbs(this._milliseconds);
      this._days = mathAbs(this._days);
      this._months = mathAbs(this._months);
      data.milliseconds = mathAbs(data.milliseconds);
      data.seconds = mathAbs(data.seconds);
      data.minutes = mathAbs(data.minutes);
      data.hours = mathAbs(data.hours);
      data.months = mathAbs(data.months);
      data.years = mathAbs(data.years);
      return this;
    }
    function duration_add_subtract__addSubtract(duration, input, value, direction) {
      var other = create__createDuration(input, value);
      duration._milliseconds += direction * other._milliseconds;
      duration._days += direction * other._days;
      duration._months += direction * other._months;
      return duration._bubble();
    }
    function duration_add_subtract__add(input, value) {
      return duration_add_subtract__addSubtract(this, input, value, 1);
    }
    function duration_add_subtract__subtract(input, value) {
      return duration_add_subtract__addSubtract(this, input, value, -1);
    }
    function absCeil(number) {
      if (number < 0) {
        return Math.floor(number);
      } else {
        return Math.ceil(number);
      }
    }
    function bubble() {
      var milliseconds = this._milliseconds;
      var days = this._days;
      var months = this._months;
      var data = this._data;
      var seconds,
          minutes,
          hours,
          years,
          monthsFromDays;
      if (!((milliseconds >= 0 && days >= 0 && months >= 0) || (milliseconds <= 0 && days <= 0 && months <= 0))) {
        milliseconds += absCeil(monthsToDays(months) + days) * 864e5;
        days = 0;
        months = 0;
      }
      data.milliseconds = milliseconds % 1000;
      seconds = absFloor(milliseconds / 1000);
      data.seconds = seconds % 60;
      minutes = absFloor(seconds / 60);
      data.minutes = minutes % 60;
      hours = absFloor(minutes / 60);
      data.hours = hours % 24;
      days += absFloor(hours / 24);
      monthsFromDays = absFloor(daysToMonths(days));
      months += monthsFromDays;
      days -= absCeil(monthsToDays(monthsFromDays));
      years = absFloor(months / 12);
      months %= 12;
      data.days = days;
      data.months = months;
      data.years = years;
      return this;
    }
    function daysToMonths(days) {
      return days * 4800 / 146097;
    }
    function monthsToDays(months) {
      return months * 146097 / 4800;
    }
    function as(units) {
      var days;
      var months;
      var milliseconds = this._milliseconds;
      units = normalizeUnits(units);
      if (units === 'month' || units === 'year') {
        days = this._days + milliseconds / 864e5;
        months = this._months + daysToMonths(days);
        return units === 'month' ? months : months / 12;
      } else {
        days = this._days + Math.round(monthsToDays(this._months));
        switch (units) {
          case 'week':
            return days / 7 + milliseconds / 6048e5;
          case 'day':
            return days + milliseconds / 864e5;
          case 'hour':
            return days * 24 + milliseconds / 36e5;
          case 'minute':
            return days * 1440 + milliseconds / 6e4;
          case 'second':
            return days * 86400 + milliseconds / 1000;
          case 'millisecond':
            return Math.floor(days * 864e5) + milliseconds;
          default:
            throw new Error('Unknown unit ' + units);
        }
      }
    }
    function duration_as__valueOf() {
      return (this._milliseconds + this._days * 864e5 + (this._months % 12) * 2592e6 + toInt(this._months / 12) * 31536e6);
    }
    function makeAs(alias) {
      return function() {
        return this.as(alias);
      };
    }
    var asMilliseconds = makeAs('ms');
    var asSeconds = makeAs('s');
    var asMinutes = makeAs('m');
    var asHours = makeAs('h');
    var asDays = makeAs('d');
    var asWeeks = makeAs('w');
    var asMonths = makeAs('M');
    var asYears = makeAs('y');
    function duration_get__get(units) {
      units = normalizeUnits(units);
      return this[units + 's']();
    }
    function makeGetter(name) {
      return function() {
        return this._data[name];
      };
    }
    var milliseconds = makeGetter('milliseconds');
    var seconds = makeGetter('seconds');
    var minutes = makeGetter('minutes');
    var hours = makeGetter('hours');
    var days = makeGetter('days');
    var months = makeGetter('months');
    var years = makeGetter('years');
    function weeks() {
      return absFloor(this.days() / 7);
    }
    var round = Math.round;
    var thresholds = {
      s: 45,
      m: 45,
      h: 22,
      d: 26,
      M: 11
    };
    function substituteTimeAgo(string, number, withoutSuffix, isFuture, locale) {
      return locale.relativeTime(number || 1, !!withoutSuffix, string, isFuture);
    }
    function duration_humanize__relativeTime(posNegDuration, withoutSuffix, locale) {
      var duration = create__createDuration(posNegDuration).abs();
      var seconds = round(duration.as('s'));
      var minutes = round(duration.as('m'));
      var hours = round(duration.as('h'));
      var days = round(duration.as('d'));
      var months = round(duration.as('M'));
      var years = round(duration.as('y'));
      var a = seconds < thresholds.s && ['s', seconds] || minutes === 1 && ['m'] || minutes < thresholds.m && ['mm', minutes] || hours === 1 && ['h'] || hours < thresholds.h && ['hh', hours] || days === 1 && ['d'] || days < thresholds.d && ['dd', days] || months === 1 && ['M'] || months < thresholds.M && ['MM', months] || years === 1 && ['y'] || ['yy', years];
      a[2] = withoutSuffix;
      a[3] = +posNegDuration > 0;
      a[4] = locale;
      return substituteTimeAgo.apply(null, a);
    }
    function duration_humanize__getSetRelativeTimeThreshold(threshold, limit) {
      if (thresholds[threshold] === undefined) {
        return false;
      }
      if (limit === undefined) {
        return thresholds[threshold];
      }
      thresholds[threshold] = limit;
      return true;
    }
    function humanize(withSuffix) {
      var locale = this.localeData();
      var output = duration_humanize__relativeTime(this, !withSuffix, locale);
      if (withSuffix) {
        output = locale.pastFuture(+this, output);
      }
      return locale.postformat(output);
    }
    var iso_string__abs = Math.abs;
    function iso_string__toISOString() {
      var seconds = iso_string__abs(this._milliseconds) / 1000;
      var days = iso_string__abs(this._days);
      var months = iso_string__abs(this._months);
      var minutes,
          hours,
          years;
      minutes = absFloor(seconds / 60);
      hours = absFloor(minutes / 60);
      seconds %= 60;
      minutes %= 60;
      years = absFloor(months / 12);
      months %= 12;
      var Y = years;
      var M = months;
      var D = days;
      var h = hours;
      var m = minutes;
      var s = seconds;
      var total = this.asSeconds();
      if (!total) {
        return 'P0D';
      }
      return (total < 0 ? '-' : '') + 'P' + (Y ? Y + 'Y' : '') + (M ? M + 'M' : '') + (D ? D + 'D' : '') + ((h || m || s) ? 'T' : '') + (h ? h + 'H' : '') + (m ? m + 'M' : '') + (s ? s + 'S' : '');
    }
    var duration_prototype__proto = Duration.prototype;
    duration_prototype__proto.abs = duration_abs__abs;
    duration_prototype__proto.add = duration_add_subtract__add;
    duration_prototype__proto.subtract = duration_add_subtract__subtract;
    duration_prototype__proto.as = as;
    duration_prototype__proto.asMilliseconds = asMilliseconds;
    duration_prototype__proto.asSeconds = asSeconds;
    duration_prototype__proto.asMinutes = asMinutes;
    duration_prototype__proto.asHours = asHours;
    duration_prototype__proto.asDays = asDays;
    duration_prototype__proto.asWeeks = asWeeks;
    duration_prototype__proto.asMonths = asMonths;
    duration_prototype__proto.asYears = asYears;
    duration_prototype__proto.valueOf = duration_as__valueOf;
    duration_prototype__proto._bubble = bubble;
    duration_prototype__proto.get = duration_get__get;
    duration_prototype__proto.milliseconds = milliseconds;
    duration_prototype__proto.seconds = seconds;
    duration_prototype__proto.minutes = minutes;
    duration_prototype__proto.hours = hours;
    duration_prototype__proto.days = days;
    duration_prototype__proto.weeks = weeks;
    duration_prototype__proto.months = months;
    duration_prototype__proto.years = years;
    duration_prototype__proto.humanize = humanize;
    duration_prototype__proto.toISOString = iso_string__toISOString;
    duration_prototype__proto.toString = iso_string__toISOString;
    duration_prototype__proto.toJSON = iso_string__toISOString;
    duration_prototype__proto.locale = locale;
    duration_prototype__proto.localeData = localeData;
    duration_prototype__proto.toIsoString = deprecate('toIsoString() is deprecated. Please use toISOString() instead (notice the capitals)', iso_string__toISOString);
    duration_prototype__proto.lang = lang;
    addFormatToken('X', 0, 0, 'unix');
    addFormatToken('x', 0, 0, 'valueOf');
    addRegexToken('x', matchSigned);
    addRegexToken('X', matchTimestamp);
    addParseToken('X', function(input, array, config) {
      config._d = new Date(parseFloat(input, 10) * 1000);
    });
    addParseToken('x', function(input, array, config) {
      config._d = new Date(toInt(input));
    });
    utils_hooks__hooks.version = '2.10.6';
    setHookCallback(local__createLocal);
    utils_hooks__hooks.fn = momentPrototype;
    utils_hooks__hooks.min = min;
    utils_hooks__hooks.max = max;
    utils_hooks__hooks.utc = create_utc__createUTC;
    utils_hooks__hooks.unix = moment__createUnix;
    utils_hooks__hooks.months = lists__listMonths;
    utils_hooks__hooks.isDate = isDate;
    utils_hooks__hooks.locale = locale_locales__getSetGlobalLocale;
    utils_hooks__hooks.invalid = valid__createInvalid;
    utils_hooks__hooks.duration = create__createDuration;
    utils_hooks__hooks.isMoment = isMoment;
    utils_hooks__hooks.weekdays = lists__listWeekdays;
    utils_hooks__hooks.parseZone = moment__createInZone;
    utils_hooks__hooks.localeData = locale_locales__getLocale;
    utils_hooks__hooks.isDuration = isDuration;
    utils_hooks__hooks.monthsShort = lists__listMonthsShort;
    utils_hooks__hooks.weekdaysMin = lists__listWeekdaysMin;
    utils_hooks__hooks.defineLocale = defineLocale;
    utils_hooks__hooks.weekdaysShort = lists__listWeekdaysShort;
    utils_hooks__hooks.normalizeUnits = normalizeUnits;
    utils_hooks__hooks.relativeTimeThreshold = duration_humanize__getSetRelativeTimeThreshold;
    var _moment = utils_hooks__hooks;
    return _moment;
  }));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5d", ["5c"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = req('5c');
  global.define = __define;
  return module.exports;
});

$__System.register('5e', ['51', '57', '58', '59', '4c', '5b', '5d'], function (_export) {
    'use strict';

    var firebase_mixin, tmpl, Vue, Dropzone, moment;
    return {
        setters: [function (_4) {
            firebase_mixin = _4['default'];
        }, function (_) {}, function (_2) {}, function (_3) {
            tmpl = _3['default'];
        }, function (_c) {
            Vue = _c['default'];
        }, function (_b) {
            Dropzone = _b['default'];
        }, function (_d) {
            moment = _d['default'];
        }],
        execute: function () {

            Vue.component('photo-panel', {
                template: tmpl,
                data: function data() {
                    return {
                        photos: []
                    };
                },
                props: ['base'],
                methods: {
                    get_photo: function get_photo(uid) {
                        return this.photos.find(function (photo) {
                            return photo.uid == uid;
                        });
                    }
                },
                computed: {
                    sorted_photos: function sorted_photos() {
                        return this.photos.sort(function (a, b) {
                            return a.val.date - b.val.date;
                        });
                    }
                },
                ready: function ready() {
                    var _this = this;

                    var fb = new Firebase(this.base);
                    fb.on('value', function (value) {});
                    fb.on("child_added", function (value) {
                        var key = value.key();
                        var photo = _this.get_photo(key);
                        if (!photo) {
                            var val = value.val();
                            _this.photos.push({ uid: key, val: val, date: moment(val.date) });
                        }
                    });
                    this.$nextTick(function () {
                        _this.$dropzone = new Dropzone("#my-awesome-dropzone", { url: "/upload" });
                    });
                }
            });
        }
    };
});
$__System.register('1', ['5', '6', '7', '53', '56', '4c', '5e'], function (_export) {
    'use strict';

    var Vue, FBPath, weather_base, work_base, photo_base, appl;
    return {
        setters: [function (_) {}, function (_2) {}, function (_3) {}, function (_4) {}, function (_5) {}, function (_c) {
            Vue = _c['default'];
        }, function (_e) {}],
        execute: function () {

            Vue.config.debug = true;

            FBPath = "https://popping-inferno-367.firebaseio.com/tests/";
            weather_base = FBPath + "weather";
            work_base = FBPath + "work";
            photo_base = FBPath + "photos";
            appl = window.appl = new Vue({
                el: ".main",
                data: {
                    loading: true,
                    welcome_msg: 'foobar',
                    weather_base: weather_base,
                    work_base: work_base,
                    photo_base: photo_base
                },
                ready: function ready() {
                    this.loading = false;
                }
            });
        }
    };
});
$__System.register('npm:skeleton-css@2.0.4/css/normalize.css!github:systemjs/plugin-css@0.1.19', [], false, function() {});
$__System.register('npm:skeleton-css@2.0.4/css/skeleton.css!github:systemjs/plugin-css@0.1.19', [], false, function() {});
$__System.register('appl/main.css!github:systemjs/plugin-css@0.1.19', [], false, function() {});
$__System.register('components/weather-panel/main.css!github:systemjs/plugin-css@0.1.19', [], false, function() {});
$__System.register('components/work-panel/main.css!github:systemjs/plugin-css@0.1.19', [], false, function() {});
$__System.register('components/photo-panel/main.css!github:systemjs/plugin-css@0.1.19', [], false, function() {});
$__System.register('npm:dropzone@4.2.0/dist/min/basic.min.css!github:systemjs/plugin-css@0.1.19', [], false, function() {});
(function(c){if (typeof document == 'undefined') return; var d=document,a='appendChild',i='styleSheet',s=d.createElement('style');s.type='text/css';d.getElementsByTagName('head')[0][a](s);s[i]?s[i].cssText=c:s[a](d.createTextNode(c));})
("/*! normalize.css v3.0.2 | MIT License | git.io/normalize */html{font-family:sans-serif;-ms-text-size-adjust:100%;-webkit-text-size-adjust:100%}body{margin:0}article,aside,details,figcaption,figure,footer,header,hgroup,main,menu,nav,section,summary{display:block}audio,canvas,progress,video{display:inline-block;vertical-align:baseline}audio:not([controls]){display:none;height:0}[hidden],template{display:none}a{background-color:transparent}a:active,a:hover{outline:0}abbr[title]{border-bottom:1px dotted}b,strong{font-weight:700}dfn{font-style:italic}h1{font-size:2em;margin:.67em 0}mark{background:#ff0;color:#000}small{font-size:80%}sub,sup{font-size:75%;line-height:0;position:relative;vertical-align:baseline}sup{top:-.5em}sub{bottom:-.25em}img{border:0}svg:not(:root){overflow:hidden}figure{margin:1em 40px}hr{-moz-box-sizing:content-box;box-sizing:content-box;height:0}pre{overflow:auto}code,kbd,pre,samp{font-family:monospace,monospace;font-size:1em}button,input,optgroup,select,textarea{color:inherit;font:inherit;margin:0}button{overflow:visible}button,select{text-transform:none} input[type=reset],button,html input[type=button],input[type=submit]{-webkit-appearance:button;cursor:pointer}button[disabled],html input[disabled]{cursor:default}button::-moz-focus-inner,input::-moz-focus-inner{border:0;padding:0}input{line-height:normal}input[type=checkbox],input[type=radio]{box-sizing:border-box;padding:0}input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{height:auto}input[type=search]{-webkit-appearance:textfield;-moz-box-sizing:content-box;-webkit-box-sizing:content-box;box-sizing:content-box}input[type=search]::-webkit-search-cancel-button,input[type=search]::-webkit-search-decoration{-webkit-appearance:none}fieldset{border:1px solid silver;margin:0 2px;padding:.35em .625em .75em}legend{border:0;padding:0}textarea{overflow:auto}optgroup{font-weight:700}table{border-collapse:collapse;border-spacing:0}td,th{padding:0}.container{position:relative;width:100%;max-width:960px;margin:0 auto;padding:0 20px;box-sizing:border-box}.column,.columns{width:100%;float:left;box-sizing:border-box}@media (min-width:400px){.container{width:85%;padding:0}}@media (min-width:550px){.container{width:80%}.column,.columns{margin-left:4%}.column:first-child,.columns:first-child{margin-left:0}.one.column,.one.columns{width:4.66666666667%}.two.columns{width:13.3333333333%}.three.columns{width:22%}.four.columns{width:30.6666666667%}.five.columns{width:39.3333333333%}.six.columns{width:48%}.seven.columns{width:56.6666666667%}.eight.columns{width:65.3333333333%}.nine.columns{width:74%}.ten.columns{width:82.6666666667%}.eleven.columns{width:91.3333333333%}.twelve.columns{width:100%;margin-left:0}.one-third.column{width:30.6666666667%}.two-thirds.column{width:65.3333333333%}.one-half.column{width:48%}.offset-by-one.column,.offset-by-one.columns{margin-left:8.66666666667%}.offset-by-two.column,.offset-by-two.columns{margin-left:17.3333333333%}.offset-by-three.column,.offset-by-three.columns{margin-left:26%}.offset-by-four.column,.offset-by-four.columns{margin-left:34.6666666667%}.offset-by-five.column,.offset-by-five.columns{margin-left:43.3333333333%}.offset-by-six.column,.offset-by-six.columns{margin-left:52%}.offset-by-seven.column,.offset-by-seven.columns{margin-left:60.6666666667%}.offset-by-eight.column,.offset-by-eight.columns{margin-left:69.3333333333%}.offset-by-nine.column,.offset-by-nine.columns{margin-left:78%}.offset-by-ten.column,.offset-by-ten.columns{margin-left:86.6666666667%}.offset-by-eleven.column,.offset-by-eleven.columns{margin-left:95.3333333333%}.offset-by-one-third.column,.offset-by-one-third.columns{margin-left:34.6666666667%}.offset-by-two-thirds.column,.offset-by-two-thirds.columns{margin-left:69.3333333333%}.offset-by-one-half.column,.offset-by-one-half.columns{margin-left:52%}}html{font-size:62.5%}body{font-size:1.5em;line-height:1.6;font-weight:400;font-family:Raleway,HelveticaNeue,\"Helvetica Neue\",Helvetica,Arial,sans-serif;color:#222}h1,h2,h3,h4,h5,h6{margin-top:0;margin-bottom:2rem;font-weight:300}h1{font-size:4rem;line-height:1.2;letter-spacing:-.1rem}h2{font-size:3.6rem;line-height:1.25;letter-spacing:-.1rem}h3{font-size:3rem;line-height:1.3;letter-spacing:-.1rem}h4{font-size:2.4rem;line-height:1.35;letter-spacing:-.08rem}h5{font-size:1.8rem;line-height:1.5;letter-spacing:-.05rem}h6{font-size:1.5rem;line-height:1.6;letter-spacing:0}@media (min-width:550px){h1{font-size:5rem}h2{font-size:4.2rem}h3{font-size:3.6rem}h4{font-size:3rem}h5{font-size:2.4rem}h6{font-size:1.5rem}}p{margin-top:0}a{color:#1EAEDB}a:hover{color:#0FA0CE}.button,button,input[type=button],input[type=reset],input[type=submit]{display:inline-block;height:38px;padding:0 30px;color:#555;text-align:center;font-size:11px;font-weight:600;line-height:38px;letter-spacing:.1rem;text-transform:uppercase;text-decoration:none;white-space:nowrap;background-color:transparent;border-radius:4px;border:1px solid #bbb;cursor:pointer;box-sizing:border-box}.button:focus,.button:hover,button:focus,button:hover,input[type=button]:focus,input[type=button]:hover,input[type=reset]:focus,input[type=reset]:hover,input[type=submit]:focus,input[type=submit]:hover{color:#333;border-color:#888;outline:0}.button.button-primary,button.button-primary,input[type=button].button-primary,input[type=reset].button-primary,input[type=submit].button-primary{color:#FFF;background-color:#33C3F0;border-color:#33C3F0}.button.button-primary:focus,.button.button-primary:hover,button.button-primary:focus,button.button-primary:hover,input[type=button].button-primary:focus,input[type=button].button-primary:hover,input[type=reset].button-primary:focus,input[type=reset].button-primary:hover,input[type=submit].button-primary:focus,input[type=submit].button-primary:hover{color:#FFF;background-color:#1EAEDB;border-color:#1EAEDB}input[type=email],input[type=text],input[type=tel],input[type=url],input[type=password],input[type=number],input[type=search],select,textarea{height:38px;padding:6px 10px;background-color:#fff;border:1px solid #D1D1D1;border-radius:4px;box-shadow:none;box-sizing:border-box}input[type=email],input[type=text],input[type=tel],input[type=url],input[type=password],input[type=number],input[type=search],textarea{-webkit-appearance:none;-moz-appearance:none;appearance:none}textarea{min-height:65px;padding-top:6px;padding-bottom:6px}input[type=email]:focus,input[type=text]:focus,input[type=tel]:focus,input[type=url]:focus,input[type=password]:focus,input[type=number]:focus,input[type=search]:focus,select:focus,textarea:focus{border:1px solid #33C3F0;outline:0}label,legend{display:block;margin-bottom:.5rem;font-weight:600}fieldset{padding:0;border-width:0}input[type=checkbox],input[type=radio]{display:inline}label>.label-body{display:inline-block;margin-left:.5rem;font-weight:400}ul{list-style:circle inside}ol{list-style:decimal inside}ol,ul{padding-left:0;margin-top:0}ol ol,ol ul,ul ol,ul ul{margin:1.5rem 0 1.5rem 3rem;font-size:90%}li{margin-bottom:1rem}code{padding:.2rem .5rem;margin:0 .2rem;font-size:90%;white-space:nowrap;background:#F1F1F1;border:1px solid #E1E1E1;border-radius:4px}pre>code{display:block;padding:1rem 1.5rem;white-space:pre}td,th{padding:12px 15px;text-align:left;border-bottom:1px solid #E1E1E1}td:first-child,th:first-child{padding-left:0}td:last-child,th:last-child{padding-right:0}.button,button{margin-bottom:1rem}fieldset,input,select,textarea{margin-bottom:1.5rem}blockquote,dl,figure,form,ol,p,pre,table,ul{margin-bottom:2.5rem}.u-full-width{width:100%;box-sizing:border-box}.u-max-full-width{max-width:100%;box-sizing:border-box}.u-pull-right{float:right}.u-pull-left{float:left}hr{margin-top:3rem;margin-bottom:3.5rem;border-width:0;border-top:1px solid #E1E1E1}.container:after,.row:after,.u-cf{content:\"\";display:table;clear:both}.main{margin-top:2em}.WeatherPanel .weather-icon{display:inline-block;line-height:1}@font-face{font-family:weather_font;src:url(/resource/iconvault_forecastfont.eot);src:url(/resources/iconvault_forecastfont.eot?#iefix) format(\"embedded-opentype\"),url(/resources/iconvault_forecastfont.woff) format(\"woff\"),url(/resources/iconvault_forecastfont.ttf) format(\"truetype\"),url(/resources/iconvault_forecastfont.svg#iconvault) format(\"svg\");font-weight:400;font-style:normal}.icon-basecloud:before,.icon-cloud:before,.icon-drizzle:before,.icon-frosty:before,.icon-hail:before,.icon-mist:before,.icon-moon:before,.icon-night:before,.icon-rainy:before,.icon-showers:before,.icon-sleet:before,.icon-snowy:before,.icon-sun:before,.icon-sunny:before,.icon-sunrise:before,.icon-sunset:before,.icon-thunder:before,.icon-windy:before,.icon-windyrain:before,.icon-windyraincloud:before,.icon-windysnow:before,.icon-windysnowcloud:before{font-family:weather_font;font-style:normal;font-weight:400;font-variant:normal;text-transform:none;line-height:1;-webkit-font-smoothing:antialiased;display:inline-block;text-decoration:inherit}.icon-night:before{content:\"\\f100\"}.icon-sunny:before{content:\"\\f101\"}.icon-frosty:before{content:\"\\f102\"}.icon-windysnow:before{content:\"\\f103\"}.icon-showers:before{content:\"\\f104\"}.icon-basecloud:before{content:\"\\f105\"}.icon-cloud:before{content:\"\\f106\"}.icon-rainy:before{content:\"\\f107\"}.icon-mist:before{content:\"\\f108\"}.icon-windysnowcloud:before{content:\"\\f109\"}.icon-drizzle:before{content:\"\\f10a\"}.icon-snowy:before{content:\"\\f10b\"}.icon-sleet:before{content:\"\\f10c\"}.icon-moon:before{content:\"\\f10d\"}.icon-windyrain:before{content:\"\\f10e\"}.icon-hail:before{content:\"\\f10f\"}.icon-sunset:before{content:\"\\f110\"}.icon-windyraincloud:before{content:\"\\f111\"}.icon-sunrise:before{content:\"\\f112\"}.icon-sun:before{content:\"\\f113\"}.icon-thunder:before{content:\"\\f114\"}.icon-windy:before{content:\"\\f115\"}.PhotoPanel .photo-item img{width:64px;float:left;margin-right:6px}.dropzone,.dropzone *{box-sizing:border-box}.dropzone{position:relative}.dropzone .dz-preview{position:relative;display:inline-block;width:120px;margin:.5em}.dropzone .dz-preview .dz-progress{display:block;height:15px;border:1px solid #aaa}.dropzone .dz-preview .dz-progress .dz-upload{display:block;height:100%;width:0;background:green}.dropzone .dz-preview .dz-error-message{color:red;display:none}.dropzone .dz-preview.dz-error .dz-error-mark,.dropzone .dz-preview.dz-error .dz-error-message{display:block}.dropzone .dz-preview.dz-success .dz-success-mark{display:block}.dropzone .dz-preview .dz-error-mark,.dropzone .dz-preview .dz-success-mark{position:absolute;display:none;left:30px;top:30px;width:54px;height:58px;left:50%;margin-left:-27px}");
})
(function(factory) {
  factory();
});
//# sourceMappingURL=appl.js.map