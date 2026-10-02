export type Next = () => Promise<unknown>;
export type MiddlewareLike<T> = (ctx: T, next: Next) => unknown | Promise<unknown>;
export type HandlerLike<T> = (ctx: T) => unknown | Promise<unknown>;

export function compose<T>(middleware: MiddlewareLike<T>[], handler: HandlerLike<T>): HandlerLike<T> {
  return function run(ctx: T): Promise<unknown> {
    let last = -1;
    function dispatch(index: number): Promise<unknown> {
      if (index <= last) return Promise.reject(new Error('next() called more than once'));
      last = index;
      const fn = index === middleware.length ? handler : middleware[index];
      if (!fn) return Promise.resolve();
      try { return Promise.resolve(fn(ctx, () => dispatch(index + 1))); }
      catch (error) { return Promise.reject(error); }
    }
    return dispatch(0);
  };
}
