MSG_UUID = null;

// Stdout/stderr indexed by message uuid
STDOUT = {};
STDERR = {};

// Files mounted and paths
FILES = [];
DIR_DATA_FILES = "/data";
DIR_DATA_URLS = "/urls";

// Initialization -- two conditions for this worker to be ready:
//   1) Got UUID from Main Thread that it sent with the "init" message
//   2) Wasm module is initialized
resolveInitWasm = null;
resolveInitWorker = null;
promiseInitWasm = new Promise(resolve => resolveInitWasm = resolve);
promiseInitWorker = new Promise(resolve => resolveInitWorker = resolve);
Promise.all([ promiseInitWasm, promiseInitWorker ])
  .then(() => send(MSG_UUID, "ready"));

var Module = {};
Module = {
  // When the module is initialized, resolve the initWasm promise
  onRuntimeInitialized: () => {
    // Setup folders
    FS.mkdir(DIR_DATA_FILES, 0o777);
    FS.mkdir(DIR_DATA_URLS, 0o777);
    // Resolve promise
    resolveInitWasm();
  },

  // Load .wasm/.data files from a custom path
  locateFile: (path, dir) => {
    var dirRoot = "";

    // Use hardcoded path if `BIOWASM_URL` was defined when creating WebWorker script
    if(typeof BIOWASM_URL !== 'undefined')
      dirRoot = BIOWASM_URL;
    // Or infer it from the path to the JS file
    else {
      var dirJS = self.location.href;
      dirRoot = dirJS.substring(0, dirJS.lastIndexOf("/") + 1);
    }
    return dirRoot + path;
  },

  // Setup print functions to store stdout/stderr based on id
  print: text => STDOUT[MSG_UUID] += `${text}\n`,
  printErr: text => STDERR[MSG_UUID] += `${text}\n`
}
function assert(condition, text) {
  if (!condition) abort("Assertion failed: " + text);
}
function threadPrintErr() {
  var text = Array.prototype.slice.call(arguments).join(" ");
  console.error(text);
}
function threadAlert() {
  var text = Array.prototype.slice.call(arguments).join(" ");
  postMessage({
    cmd: "alert",
    text: text,
    threadId: Module["_pthread_self"](),
  });
}
var out = function() {
  throw "out() is not defined in worker.js.";
};
var err = threadPrintErr;
this.alert = threadAlert;
Module["instantiateWasm"] = function(info, receiveInstance) {
  var instance = new WebAssembly.Instance(Module["wasmModule"], info);
  Module["wasmModule"] = null;
  receiveInstance(instance);
  return instance.exports;
};
function moduleLoaded() {
  postMessage({ cmd: "loaded" });
}
this.onmessage = function(e) {
  try {
    if (e.data.cmd === "load") {
      Module["wasmModule"] = e.data.wasmModule;
      Module["wasmMemory"] = e.data.wasmMemory;
      Module["buffer"] = Module["wasmMemory"].buffer;
      Module["ENVIRONMENT_IS_PTHREAD"] = true;
      if (typeof e.data.urlOrBlob === "string") {
        console.log('e.data.urlOrBlob is string')
        importScripts(e.data.urlOrBlob);
      } else {
        console.log('e.data.urlOrBlob is not string')
        var objectUrl = URL.createObjectURL(e.data.urlOrBlob);
        importScripts(objectUrl);
        URL.revokeObjectURL(objectUrl);
      }
      moduleLoaded();
    } else if (e.data.cmd === "objectTransfer") {
      Module["PThread"].receiveObjectTransfer(e.data);
    } else if (e.data.cmd === "run") {
      Module["__performance_now_clock_drift"] = performance.now() - e.data.time;
      Module["__emscripten_thread_init"](e.data.threadInfoStruct, 0, 0);
      var max = e.data.stackBase;
      var top = e.data.stackBase + e.data.stackSize;
      assert(e.data.threadInfoStruct);
      assert(top != 0);
      assert(max != 0);
      assert(top > max);
      Module["establishStackSpace"](top, max);
      Module["_emscripten_tls_init"]();
      Module["PThread"].receiveObjectTransfer(e.data);
      Module["PThread"].setThreadStatus(Module["_pthread_self"](), 1);
      try {
        var result = Module["invokeEntryPoint"](
          e.data.start_routine,
          e.data.arg
        );
        Module["checkStackCookie"]();
        if (!Module["getNoExitRuntime"]()) Module["PThread"].threadExit(result);
      } catch (ex) {
        if (ex === "Canceled!") {
          Module["PThread"].threadCancel();
        } else if (ex != "unwind") {
          if (typeof Module["_emscripten_futex_wake"] !== "function") {
            err("Thread Initialisation failed.");
            throw ex;
          }
          if (ex instanceof Module["ExitStatus"]) {
            if (Module["getNoExitRuntime"]()) {
              err(
                "Pthread 0x" +
                  Module["_pthread_self"]().toString(16) +
                  " called exit(), staying alive due to noExitRuntime."
              );
            } else {
              err(
                "Pthread 0x" +
                  Module["_pthread_self"]().toString(16) +
                  " called exit(), calling threadExit."
              );
              Module["PThread"].threadExit(ex.status);
            }
          } else {
            Module["PThread"].threadExit(-2);
            throw ex;
          }
        } else {
          err(
            "Pthread 0x" +
              Module["_pthread_self"]().toString(16) +
              " completed its pthread main entry point with an unwind, keeping the pthread worker alive for asynchronous operation."
          );
        }
      }
    } else if (e.data.cmd === "cancel") {
      if (Module["_pthread_self"]()) {
        Module["PThread"].threadCancel();
      }
    } else if (e.data.target === "setimmediate") {
    } else if (e.data.cmd === "processThreadQueue") {
      if (Module["_pthread_self"]()) {
        Module["_emscripten_current_thread_process_queued_calls"]();
      }
    } else {
      err("worker.js received unknown command " + e.data.cmd);
      err(e.data);
    }
  } catch (ex) {
    err("worker.js onmessage() captured an uncaught exception: " + ex);
    if (ex && ex.stack) err(ex.stack);
    throw ex;
  }
};
if (
  typeof process === "object" &&
  typeof process.versions === "object" &&
  typeof process.versions.node === "string"
) {
  self = { location: { href: __filename } };
  var onmessage = this.onmessage;
  var nodeWorkerThreads = require("worker_threads");
  global.Worker = nodeWorkerThreads.Worker;
  var parentPort = nodeWorkerThreads.parentPort;
  parentPort.on("message", function(data) {
    onmessage({ data: data });
  });
  var nodeFS = require("fs");
  var nodeRead = function(filename) {
    return nodeFS.readFileSync(filename, "utf8");
  };
  function globalEval(x) {
    global.require = require;
    global.Module = Module;
    eval.call(null, x);
  }
  importScripts = function(f) {
    console.log('importScript f:', f);
    globalEval(nodeRead(f));
  };
  postMessage = function(msg) {
    parentPort.postMessage(msg);
  };
  if (typeof performance === "undefined") {
    performance = {
      now: function() {
        return Date.now();
      },
    };
  }
}
