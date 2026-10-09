/**
 * Built-in feature modules (5.1+). Importing this module registers each of them with the feature registry
 * ({@link ../gateway/features.ts}); they are mounted under `/api/v1/admin/<id>`.
 *
 * @module features
 */
import './conformance.js';
import './regions.js';
import './edge-fleet.js';
import './marketplace.js';
import './sessions.js';
import './dlp.js';
import './adaptive.js';
import './api-upstreams.js';
import './workflows.js';
import './genai-otel.js';
import './identity.js';
import './policy-sim.js';
import './anomaly.js';
import './billing.js';
import './k8s.js';
import './terraform.js';
import './console.js';
import './sanitize.js';
import './semantic-cache.js';
import './rollouts.js';
import './offline.js';
import './approval-flows.js';
import './compliance-reports.js';
import './agent-identity.js';
import './a2a-federation.js';
import './debug-sessions.js';
import './cost-advisor.js';
import './blue-green.js';
import './data-lineage.js';
import './config-assistant.js';
import './chaos.js';
import './multimodal.js';
import './edge-runtime.js';
import './confidential.js';
import './tool-registry.js';
import './sla.js';
import './self-healing.js';
import './pq-tls.js';
import './ecosystem.js';
import './policy-engine.js';
import './kernel.js';

export { listFeatures, registerFeature, createFeatureRouter } from '../gateway/features.js';
