// auth.config.ts
// Purpose: Tells Convex to accept Clerk-issued JWTs. The issuer comes from the
// CLERK_JWT_ISSUER_DOMAIN deployment env var; the Clerk JWT template is named "convex"
// so the token audience (applicationID) is "convex". The identity's subject is the
// Clerk user id used as the user key throughout the schema.
//
// Last modified: 2026-10-28

export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
  ],
};
