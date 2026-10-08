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

export { listFeatures, registerFeature, createFeatureRouter } from '../gateway/features.js';
