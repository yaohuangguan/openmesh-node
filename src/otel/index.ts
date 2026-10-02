import type { AppEvent, AppObserver } from '../core/app.js';
import type { PeerPoolEvent, PeerPoolObserver } from '../mesh/index.js';

export type OpenTelemetryAttributeValue = string | number | boolean;
export type OpenTelemetryAttributes = Record<string, OpenTelemetryAttributeValue>;

export interface OpenTelemetryCounter {
  add(value: number, attributes?: OpenTelemetryAttributes): void;
}

export interface OpenTelemetryHistogram {
  record(value: number, attributes?: OpenTelemetryAttributes): void;
}

export interface OpenTelemetryMeter {
  createCounter(name: string, options?: { description?: string; unit?: string }): OpenTelemetryCounter;
  createHistogram(name: string, options?: { description?: string; unit?: string }): OpenTelemetryHistogram;
}

export interface OpenTelemetryObservers {
  onAppEvent: AppObserver;
  onPeerEvent: PeerPoolObserver;
}

export interface OpenTelemetryObserverOptions {
  meter: OpenTelemetryMeter;
  attributes?: OpenTelemetryAttributes;
}

function merge(
  base: OpenTelemetryAttributes,
  attributes: OpenTelemetryAttributes
): OpenTelemetryAttributes {
  return Object.keys(base).length ? { ...base, ...attributes } : attributes;
}

function routeAttributes(event: Extract<AppEvent, { type: 'request.start' | 'request.finish' | 'request.error' }>): OpenTelemetryAttributes {
  return {
    'http.request.method': event.method,
    'http.route': event.route || 'unmatched'
  };
}

function peerAttributes(event: Extract<PeerPoolEvent, { peer: unknown }>): OpenTelemetryAttributes {
  return { 'openmesh.peer.id': event.peer.id };
}

export function createOpenTelemetryObservers({
  meter,
  attributes = {}
}: OpenTelemetryObserverOptions): OpenTelemetryObservers {
  if (!meter || typeof meter.createCounter !== 'function' || typeof meter.createHistogram !== 'function') {
    throw new TypeError('OpenTelemetry meter must provide createCounter() and createHistogram()');
  }
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
    throw new TypeError('OpenTelemetry attributes must be an object');
  }

  const requestStarted = meter.createCounter('openmesh.server.request.started', {
    description: 'OpenMesh inbound requests started'
  });
  const requestCompleted = meter.createCounter('openmesh.server.request.completed', {
    description: 'OpenMesh inbound requests completed'
  });
  const requestErrors = meter.createCounter('openmesh.server.request.errors', {
    description: 'OpenMesh inbound request errors'
  });
  const requestDuration = meter.createHistogram('openmesh.server.request.duration', {
    description: 'OpenMesh inbound request duration',
    unit: 's'
  });
  const serverLifecycle = meter.createCounter('openmesh.server.lifecycle', {
    description: 'OpenMesh server lifecycle events'
  });

  const peerAttempts = meter.createCounter('openmesh.peer.request.attempts', {
    description: 'OpenMesh outbound peer attempts'
  });
  const peerSuccesses = meter.createCounter('openmesh.peer.request.successes', {
    description: 'OpenMesh outbound peer successes'
  });
  const peerFailures = meter.createCounter('openmesh.peer.request.failures', {
    description: 'OpenMesh outbound peer failures'
  });
  const peerCancellations = meter.createCounter('openmesh.peer.request.cancellations', {
    description: 'OpenMesh outbound peer cancellations'
  });
  const peerDuration = meter.createHistogram('openmesh.peer.request.duration', {
    description: 'OpenMesh outbound peer attempt duration',
    unit: 's'
  });
  const admissionQueued = meter.createCounter('openmesh.peer.admission.queued', {
    description: 'OpenMesh peer requests queued by admission control'
  });
  const admissionRejected = meter.createCounter('openmesh.peer.admission.rejected', {
    description: 'OpenMesh peer requests rejected by admission control'
  });
  const concurrencyLimit = meter.createHistogram('openmesh.peer.concurrency.limit', {
    description: 'OpenMesh adaptive concurrency limit observations'
  });

  const onAppEvent: AppObserver = event => {
    if (event.type === 'request.start') {
      requestStarted.add(1, merge(attributes, routeAttributes(event)));
      return;
    }
    if (event.type === 'request.finish') {
      const labels = merge(attributes, {
        ...routeAttributes(event),
        'http.response.status_code': event.statusCode,
        'openmesh.request.aborted': event.aborted
      });
      requestCompleted.add(1, labels);
      requestDuration.record(event.durationMs / 1000, labels);
      return;
    }
    if (event.type === 'request.error') {
      requestErrors.add(1, merge(attributes, {
        ...routeAttributes(event),
        ...(event.code ? { 'error.type': event.code } : {}),
        ...(event.statusCode !== undefined ? { 'http.response.status_code': event.statusCode } : {})
      }));
      return;
    }
    serverLifecycle.add(1, merge(attributes, { 'openmesh.server.state': event.type.slice('server.'.length) }));
  };

  const onPeerEvent: PeerPoolObserver = event => {
    if (event.type === 'admission.queued') {
      admissionQueued.add(1, attributes);
      return;
    }
    if (event.type === 'admission.rejected') {
      admissionRejected.add(1, attributes);
      return;
    }
    if (event.type === 'concurrency.changed') {
      concurrencyLimit.record(event.current, merge(attributes, { 'openmesh.concurrency.reason': event.reason }));
      return;
    }

    const labels = merge(attributes, {
      ...peerAttributes(event),
      'http.request.method': event.method
    });
    if (event.type === 'peer.attempt') {
      peerAttempts.add(1, labels);
      return;
    }
    if (event.type === 'peer.success') {
      const successLabels = {
        ...labels,
        'http.response.status_code': event.statusCode
      };
      peerSuccesses.add(1, successLabels);
      peerDuration.record(event.latencyMs / 1000, successLabels);
      return;
    }
    if (event.type === 'peer.failure') {
      const failureLabels = {
        ...labels,
        ...(event.code ? { 'error.type': event.code } : {}),
        ...(event.statusCode !== undefined ? { 'http.response.status_code': event.statusCode } : {})
      };
      peerFailures.add(1, failureLabels);
      peerDuration.record(event.latencyMs / 1000, failureLabels);
      return;
    }
    peerCancellations.add(1, labels);
  };

  return { onAppEvent, onPeerEvent };
}
