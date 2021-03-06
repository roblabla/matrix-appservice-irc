/*eslint no-invalid-this: 0 */
"use strict";
var Promise = require("bluebird");
var promiseutil = require("../promiseutil");

/**
 * Construct a new Queue which will process items FIFO.
 * @param {Function} processFn The function to invoke when the item being processed
 * is in its critical section. Only 1 item at any one time will be calling this function.
 * The function should return a Promise which is resolved/rejected when the next item
 * can be taken from the queue.
 */
function Queue(processFn) {
    this._queue = [];
    this._processing = null;
    this._procFn = processFn; // critical section Promise<result> = fn(item)
}

/**
 * Queue up a request for the critical section function.
 * @param {string} id An ID to associate with this request. If there is already a
 * request with this ID, the promise for that request will be returned.
 * @param {*} thing The item to enqueue. It will be passed verbatim to the critical
 * section function passed in the constructor.
 * @return {Promise} A promise which will be resolved/rejected when the queued item
 * has been processed.
 */
Queue.prototype.enqueue = function(id, thing) {
    for (var i = 0; i < this._queue.length; i++) {
        if (this._queue[i].id === id) {
            return this._queue[i].defer.promise;
        }
    }
    let defer = promiseutil.defer();
    this._queue.push({
        id: id,
        item: thing,
        defer: defer
    });
    // always process stuff asyncly, never syncly.
    process.nextTick(() => {
        this._consume();
    });
    return defer.promise;
};

Queue.prototype._consume = Promise.coroutine(function*() {
    if (this._processing) {
        return;
    }
    this._processing = this._queue.shift();
    if (!this._processing) {
        return;
    }
    try {
        let thing = this._procFn(this._processing.item);
        let result = yield thing;
        this._processing.defer.resolve(result);
    }
    catch (err) {
        this._processing.defer.reject(err);
    }
    finally {
        this._processing = null;
    }
    this._consume();
});

module.exports = Queue;
