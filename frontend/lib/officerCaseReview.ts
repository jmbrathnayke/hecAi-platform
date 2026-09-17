// Officer case review client (final governance workflow).
//
// A citizen's report reaches the field officers of its DS division as a push notification; a tap
// opens /officer/cases/<ref>, which uses these calls. The officer takes responsibility for the case,
// captures THEIR OWN verification photo at the site, classifies it with MobileNetV2 on this device,
// and submits only the classification result. No image is uploaded: the citizen's photo is not the
// model input, and the officer's photo never leaves the phone.
//
// Backend: app/api/v1/officer_cases.py. Scope (own case or assigned division), the audit trail and
// the AI-assisted estimate are all server-side; nothing here is a security boundary.
import { getAccessToken } from "@/lib/auth";
import type { ClassId, ClassificationResult } from "@/lib/mobilenet";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export interface OfficerCaseDetail {
  case: {
    canonical_id: string;
    offline_id: string | null;
    status: string;
    damage_category: string | null;
    gps_lat: number | null;
    gps_lng: number | null;
    submitted_at: string | null;
    updated_at: string | null;
    submitted_via: string | null;
    submitted_by_officer: boolean;
    district: string | null;
    ds_division: string | null;
    household_ref: string | null;
  };
  workflow: {
    stage: string;
    assigned_officer_id: string | null;
    assigned_to_me: boolean;
    officer_review_started_at: string | null;
    officer_assessed_at: string | null;
    assessed_by_me: boolean;
  };
  ai_result: {
    prediction: string;
    confidence: number | null;
    was_overridden: boolean;
    override_category: string | null;
    model_version: string | null;
    ai_severity: string | null;
    created_at: string | null;
  } | null;
  ai_assisted_estimate: {
    amount_lkr: number;
    raw_estimate_lkr: number;
    capped: boolean;
    model_version: string | null;
    created_at: string | null;
    is_final_decision: false;
  } | null;
  history: { event: string; created_at: string | null }[];
  actions: { can_start_review: boolean; can_assess: boolean; already_assessed: boolean };
}

export type ReviewFailure =
  | { reason: "no-session" }
  | { reason: "signed-out" }
  | { reason: "forbidden" }
  | { reason: "not-found" }
  | { reason: "closed"; status: string | null }
  | { reason: "invalid"; code: string }
  | { reason: "server"; status: number }
  | { reason: "network" };

export type ReviewResult = { ok: true; detail: OfficerCaseDetail } | { ok: false; failure: ReviewFailure };

export interface OverrideChoice {
  category: ClassId;
  reason: string;
}

/**
 * The request body for one assessment: the model's own prediction, and the officer's correction
 * beside it when they disagreed. Field names are the research log's (inference_log), so an
 * assessment is validated by exactly the rules every other classification is.
 */
export function buildAssessmentBody(
  result: Pick<ClassificationResult, "classId" | "confidence" | "severity" | "processingTimeMs" | "modelVersion">,
  override: OverrideChoice | null,
): Record<string, unknown> {
  const overridden = override !== null && override.category !== result.classId;
  return {
    model_type: "mobilenetv2",
    model_version: result.modelVersion,
    prediction: result.classId,
    confidence: result.confidence,
    ai_severity: result.severity,
    ai_processing_time_ms: Math.max(0, Math.round(result.processingTimeMs)),
    was_overridden: overridden,
    override_category: overridden ? override!.category : null,
    override_reason: overridden ? override!.reason.trim() : null,
  };
}

async function call(path: string, init: RequestInit = {}): Promise<ReviewResult> {
  const token = await getAccessToken();
  if (!token) return { ok: false, failure: { reason: "no-session" } };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${token}`,
      },
    });
  } catch {
    return { ok: false, failure: { reason: "network" } };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const code = typeof (body as { error?: unknown })?.error === "string" ? (body as { error: string }).error : "";

  if (res.ok && body && typeof body === "object" && "case" in body) {
    return { ok: true, detail: body as OfficerCaseDetail };
  }
  if (res.status === 401) return { ok: false, failure: { reason: "signed-out" } };
  if (res.status === 403) return { ok: false, failure: { reason: "forbidden" } };
  // 404 for a case outside this officer's divisions as well as a missing one (by design).
  if (res.status === 404) return { ok: false, failure: { reason: "not-found" } };
  if (res.status === 409 && code === "case_not_open") {
    const status = (body as { status?: unknown })?.status;
    return { ok: false, failure: { reason: "closed", status: typeof status === "string" ? status : null } };
  }
  if (res.status === 400) return { ok: false, failure: { reason: "invalid", code } };
  return { ok: false, failure: { reason: "server", status: res.status } };
}

const path = (ref: string) => `/officer/cases/${encodeURIComponent(ref)}`;

export function getOfficerCase(ref: string): Promise<ReviewResult> {
  return call(path(ref));
}

export function startOfficerReview(ref: string): Promise<ReviewResult> {
  return call(`${path(ref)}/start-review`, { method: "POST" });
}

export function submitOfficerAssessment(ref: string, body: Record<string, unknown>): Promise<ReviewResult> {
  return call(`${path(ref)}/assessment`, { method: "POST", body: JSON.stringify(body) });
}

// ------------------------------------------------------------------------------ case history

/** Delivery bookkeeping (push/email/SMS outcomes). Kept on the administrator's audit view. */
export function isDeliveryEvent(event: string): boolean {
  return /^(push_|email_|sms_|staff_push_)/.test(event);
}

/** Workflow events with a translated label under officer.caseReview.events. */
export const WORKFLOW_EVENTS = [
  "submitted",
  "case_synced",
  "officer_viewed_case",
  "officer_review_started",
  "officer_assessment_recorded",
  "officer_classification_not_recorded",
  "compensation_estimate_generated",
  "compensation_estimate_not_regenerated",
  "compensation_estimate_unavailable",
  "case_approved",
  "case_rejected",
  "case_info_requested",
  "case_escalated",
  "ds_final_decision",
  "ds_authorized_payment",
  "case_paid",
] as const;

export function isWorkflowEvent(event: string): event is (typeof WORKFLOW_EVENTS)[number] {
  return (WORKFLOW_EVENTS as readonly string[]).includes(event);
}
