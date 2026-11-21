export const APPOINTMENT_KIND_NAMES = [
  "doctor_visit",
  "dentist",
  "eye_doctor",
  "hearing",
  "physical_therapy",
  "medical_test",
  "vaccine",
  "hair",
  "group_activity",
  "meal",
  "family_visit",
  "video_call",
  "phone_call",
  "meeting",
  "home_service",
  "other",
] as const;

export const INFO_TOPICS = [
  "prescription_ready",
  "prescription_coming",
  "package_arrived",
  "package_coming",
  "personal_note",
] as const;

export const DECISION_REASONS = [
  "cancellation",
  "bill_or_payment",
  "account_or_credentials",
  "reply_needed",
  "legal_or_government",
  "health_result",
  "home_visit",
  "other",
] as const;

export const SUSPICIONS = ["scam", "money_request", "credentials", "impersonation"] as const;

export const ESCALATION_REASONS = [
  ...DECISION_REASONS,
  ...SUSPICIONS,
  "phone_call",
  "unverified_sender",
  "unclear_appointment",
  "unclear_reschedule",
  "conflict",
  "daily_limit",
] as const;
