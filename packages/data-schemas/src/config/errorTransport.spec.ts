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

    it('omits context entirely when there are no scalar extras', () => {
      const doc = transport.buildDoc({ level: 'error', message: 'm' });
      expect(doc.context).toBeUndefined();
    });

    it('defaults level to error and coerces a non-string message', () => {
      const doc = transport.buildDoc({ message: 42 } as never);
      expect(doc.level).toBe('error');
      expect(doc.message).toBe('42');
    });
  });
});
