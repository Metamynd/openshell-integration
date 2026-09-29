import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMiddlewareProto } from '../src/proto.mjs';

test('vendored protos expose the middleware services the adapter implements', () => {
  const { SupervisorMiddleware, HttpResponsePreReturn } = loadMiddlewareProto();

  assert.deepEqual(Object.keys(SupervisorMiddleware.service).sort(), [
    'Describe',
    'EvaluateHttpRequest',
    'EvaluateWebSocketSession',
    'ValidateConfig',
  ]);
  assert.equal(SupervisorMiddleware.service.EvaluateHttpRequest.path,
    '/openshell.middleware.v1.SupervisorMiddleware/EvaluateHttpRequest');

  const evaluate = HttpResponsePreReturn.service.Evaluate;
  assert.equal(evaluate.requestStream, true);
  assert.equal(evaluate.responseStream, true);
});
