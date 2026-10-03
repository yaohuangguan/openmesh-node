## What problem does this solve?

Describe the concrete workload, failure mode, or maintenance problem.

## What changes?

Keep the explanation behavioral: what is different for callers, operators, or adapter authors?

## Semantics

For runtime/network changes, cover the relevant behavior:

- retry / replay
- timeout / deadline
- cancellation
- overload / admission
- stream commitment
- shutdown / drain
- compatibility

## Validation

Check what applies:

- [ ] Runtime tests
- [ ] Strict TypeScript check
- [ ] ESM + CommonJS consumer types
- [ ] Packed npm tarball smoke
- [ ] Real HTTP / Redis integration
- [ ] Benchmark before/after for native request-path changes
- [ ] Documentation updated

If performance changed, include the command and raw report rather than only a percentage.
