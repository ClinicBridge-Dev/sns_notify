(function (root) {
  function createSerialQueue() {
    let tail = Promise.resolve();
    return function run(fn) {
      const result = tail.then(() => fn());
      tail = result.then(() => undefined, () => undefined);
      return result;
    };
  }
  root.createSerialQueue = createSerialQueue;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
