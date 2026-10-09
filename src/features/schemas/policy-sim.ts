/**
 * Config schema of the `policy-sim` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/policy-sim
 */

import { z } from 'zod';
import { invalidPolicy } from '../../policy/tool-policy.js';
import { PolicyRuleSchema } from '../../policy/rule-schema.js';
import type { ToolPolicyConfig } from '../../utils/types.js';

export const policyFields = { rules: z.array(PolicyRuleSchema).default([]), default: z.enum(['allow', 'deny', 'approve']).default('allow') };
export const validRegexes = (p: { rules: unknown[] }, ctx: z.RefinementCtx) => {
  const bad = invalidPolicy(p as ToolPolicyConfig);
  if (bad) ctx.addIssue({ code: 'custom', message: bad });
};
export const CandidatePolicySchema = z.object(policyFields).strict().superRefine(validRegexes);
export const PolicyShadowSchema = z.object({ ...policyFields, enabled: z.boolean().default(true) }).strict().superRefine(validRegexes);
export type PolicyShadowConfig = z.input<typeof PolicyShadowSchema>;
