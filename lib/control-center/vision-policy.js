export function getVisionPolicy() {
  return {
    requested: true,
    ready: false,
    status: 'SEZAR_REVIEW_REQUIRED',
    provider: 'ChatGPT Work',
    model: 'Sezar creative workflow',
    credential_ready: true,
    credential_required: false,
    billing_required: false,
    external_ai_cost_usd: 0,
    blockers: ['visual_review_not_completed']
  };
}
