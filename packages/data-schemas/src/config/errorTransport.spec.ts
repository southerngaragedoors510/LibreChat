import { MongoErrorTransport } from './errorTransport';

describe('MongoErrorTransport', () => {
  const makeModel = () => ({ create: jest.fn().mockResolvedValue(undefined) });

  it('writes a document when connected and the model is registered', () => {
    const model = makeModel();
    const transport = new MongoErrorTransport({
      getModel: () => model as never,
      isConnected: () => true,
    });

    const callback = jest.fn();
    transport.log({ level: 'error', message: 'boom' }, callback);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(model.create).toHaveBeenCalledTimes(1);
    const doc = model.create.mock.calls[0][0];
    expect(doc.level).toBe('error');
    expect(doc.message).toBe('boom');
    expect(doc.timestamp).toBeInstanceOf(Date);
  });

  it('drops the entry (no write) when the DB is not connected', () => {
    const model = makeModel();
    const transport = new MongoErrorTransport({
      getModel: () => model as never,
      isConnected: () => false,
    });

    const callback = jest.fn();
    transport.log({ level: 'error', message: 'boom' }, callback);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(model.create).not.toHaveBeenCalled();
  });

  it('drops the entry when the model is not yet registered', () => {
    const transport = new MongoErrorTransport({
      getModel: () => undefined,
      isConnected: () => true,
    });

    const callback = jest.fn();
    expect(() => transport.log({ level: 'error', message: 'boom' }, callback)).not.toThrow();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('never throws and still calls back when the model.create throws synchronously', () => {
    const model = {
      create: jest.fn(() => {
        throw new Error('sync failure');
      }),
    };
    const transport = new MongoErrorTransport({
      getModel: () => model as never,
      isConnected: () => true,
    });

    const callback = jest.fn();
    expect(() => transport.log({ level: 'error', message: 'boom' }, callback)).not.toThrow();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('swallows async write rejection without an unhandled rejection', async () => {
    const model = { create: jest.fn().mockRejectedValue(new Error('write failed')) };
    const transport = new MongoErrorTransport({
      getModel: () => model as never,
      isConnected: () => true,
    });

    const callback = jest.fn();
    transport.log({ level: 'error', message: 'boom' }, callback);
    // Let the rejected promise settle; the .catch in persist() must absorb it.
    await Promise.resolve();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('does not leak the in-flight counter when create throws synchronously', () => {
    let shouldThrow = true;
    const model = {
      create: jest.fn(() => {
        if (shouldThrow) {
          throw new Error('sync failure');
        }
        return Promise.resolve();
      }),
    };
    const transport = new MongoErrorTransport({
      getModel: () => model as never,
      isConnected: () => true,
      maxInFlight: 1,
    });

    // First call throws synchronously — must NOT increment in-flight.
    transport.log({ level: 'error', message: 'first' }, jest.fn());
    // If the counter had leaked to 1 (== cap), this second write would be dropped.
    shouldThrow = false;
    transport.log({ level: 'error', message: 'second' }, jest.fn());

    expect(model.create).toHaveBeenCalledTimes(2);
  });

  it('drops entries once the in-flight cap is reached', () => {
    // Never-settling creates so in-flight stays pinned at the cap.
    const model = { create: jest.fn(() => new Promise(() => undefined)) };
    const transport = new MongoErrorTransport({
      getModel: () => model as never,
      isConnected: () => true,
      maxInFlight: 2,
    });

    for (let i = 0; i < 5; i++) {
      transport.log({ level: 'error', message: `msg-${i}` }, jest.fn());
    }

    expect(model.create).toHaveBeenCalledTimes(2);
  });

  it('resumes writing after in-flight inserts settle', async () => {
    let resolveCreate: (() => void) | undefined;
    const model = {
      create: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveCreate = resolve;
          }),
      ),
    };
    const transport = new MongoErrorTransport({
      getModel: () => model as never,
      isConnected: () => true,
      maxInFlight: 1,
    });

    transport.log({ level: 'error', message: 'a' }, jest.fn());
    transport.log({ level: 'error', message: 'b' }, jest.fn()); // dropped (at cap)
    expect(model.create).toHaveBeenCalledTimes(1);

    resolveCreate?.();
    await Promise.resolve();
    await Promise.resolve();

    transport.log({ level: 'error', message: 'c' }, jest.fn()); // slot freed
    expect(model.create).toHaveBeenCalledTimes(2);
  });

  describe('buildDoc', () => {
    const transport = new MongoErrorTransport({
      getModel: () => undefined,
      isConnected: () => false,
    });

    it('truncates an over-long message', () => {
      const doc = transport.buildDoc({ level: 'error', message: 'x'.repeat(5000) });
      expect((doc.message as string).length).toBe(4000);
    });

    it('truncates an over-long stack', () => {
      const doc = transport.buildDoc({ level: 'error', message: 'm', stack: 'y'.repeat(9000) });
      expect((doc.stack as string).length).toBe(8000);
    });

    it('captures only scalar context fields, dropping objects/functions', () => {
      const doc = transport.buildDoc({
        level: 'error',
        message: 'm',
        userId: 'user-123',
        attempt: 3,
        ok: false,
        nested: { a: 1 },
        fn: () => undefined,
      });
      expect(doc.context).toEqual({ userId: 'user-123', attempt: 3, ok: false });
    });

    it('redacts a secret pattern in the message', () => {
      const doc = transport.buildDoc({
        level: 'error',
        message: 'auth failed with Bearer supersecrettoken123',
      });
      expect(doc.message).not.toContain('supersecrettoken123');
      expect(doc.message).toContain('[REDACTED]');
    });

    it('redacts a secret pattern in the stack', () => {
      const doc = transport.buildDoc({
        level: 'error',
        message: 'm',
        stack: 'Error: boom\n  at handler (sk-abcDEF123456 leaked)',
      });
      expect(doc.stack).not.toContain('sk-abcDEF123456');
      expect(doc.stack).toContain('[REDACTED]');
    });

    it('redacts sensitive-keyed context fields but keeps safe scalars', () => {
      const doc = transport.buildDoc({
        level: 'error',
        message: 'm',
        password: 'hunter2',
        token: 'tok_abc',
        authorization: 'Bearer xyz',
        userId: 'user-123',
        attempt: 4,
      });
      expect(doc.context).toEqual({
        password: '[REDACTED]',
        token: '[REDACTED]',
        authorization: '[REDACTED]',
        userId: 'user-123',
        attempt: 4,
      });
    });

    it('redacts a secret pattern inside a non-sensitive-keyed string value', () => {
      const doc = transport.buildDoc({
        level: 'error',
        message: 'm',
        detail: 'called with api_key=leakedvalue123',
      });
      expect(doc.context?.detail).not.toContain('leakedvalue123');
      expect(doc.context?.detail as string).toContain('[REDACTED]');
    });

    it('omits context entirely when there are no scalar extras', () => {
      const doc = transport.buildDoc({ level: 'error', message: 'm' });
      expect(doc.context).toBeUndefined();
    });

    it('defaults level to error', () => {
      const doc = transport.buildDoc({ message: 'm' } as never);
      expect(doc.level).toBe('error');
    });

    it('extracts message and stack when the message itself is an error-like object', () => {
      const doc = transport.buildDoc({
        level: 'error',
        message: { message: 'e-msg', stack: 'Error: e-msg\n  at x' },
      } as never);
      expect(doc.message).toBe('e-msg');
      expect(doc.stack).toContain('Error: e-msg');
    });

    it('extracts the stack from an Error in splat while keeping the prefix message', () => {
      const err = new Error('boom-detail');
      const info = {
        level: 'error',
        message: '[Prefix] failed',
        [Symbol.for('splat')]: [err],
      } as unknown as Record<string, unknown>;
      const doc = transport.buildDoc(info);
      expect(doc.message).toBe('[Prefix] failed');
      expect(doc.stack).toContain('boom-detail');
    });

    it('falls back to a placeholder when no message can be resolved', () => {
      const doc = transport.buildDoc({ level: 'error' } as never);
      expect(doc.message).toBe('(no message)');
    });
  });
});
