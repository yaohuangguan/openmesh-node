'use strict';
function compose(middleware, handler) {
  return function run(ctx) {
    let last = -1;
    function dispatch(index) {
      if (index <= last) return Promise.reject(new Error('next() called more than once'));
      last = index;
      const fn = index === middleware.length ? handler : middleware[index];
      if (!fn) return Promise.resolve();
      try { return Promise.resolve(fn(ctx, () => dispatch(index + 1))); } catch (error) { return Promise.reject(error); }
    }
    return dispatch(0);
  };
}
module.exports = { compose };
