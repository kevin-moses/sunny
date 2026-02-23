import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, error, getUserId, success } from "../_shared/response.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

serve(async (req: Request) => {
  const started = Date.now();
  const userId = getUserId(req);
  const url = new URL(req.url);

  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders() });
    }

    if (req.method !== "GET") {
      return error("Method not allowed", "METHOD_NOT_ALLOWED", 400);
    }

    const conversationId = url.searchParams.get("conversation_id");
    if (!conversationId || !UUID_REGEX.test(conversationId)) {
      return error("conversation_id must be a valid UUID", "INVALID_CONVERSATION_ID", 400);
    }

    const { data: conversation, error: convoError } = await supabaseAdmin
      .from("conversations")
      .select("id,summary,sentiment,topics")
      .eq("id", conversationId)
      .eq("user_id", userId)
      .maybeSingle();

    if (convoError) {
      console.error("get-messages conversation lookup failed", convoError);
      return error("Failed to load conversation", "CONVERSATION_FETCH_FAILED", 500);
    }

    if (!conversation) {
      return error("Conversation not found", "CONVERSATION_NOT_FOUND", 404);
    }

    const { data: messages, error: messagesError } = await supabaseAdmin
      .from("messages")
      .select("id,conversation_id,role,content,timestamp")
      .eq("conversation_id", conversationId)
      .order("timestamp", { ascending: true });

    if (messagesError) {
      console.error("get-messages messages query failed", messagesError);
      return error("Failed to load messages", "MESSAGES_FETCH_FAILED", 500);
    }

    return success({
      messages: messages ?? [],
      conversation: {
        summary: conversation.summary,
        sentiment: conversation.sentiment,
        topics: conversation.topics,
      },
    });
  } catch (err) {
    console.error("get-messages unhandled error", err);
    return error("Internal server error", "INTERNAL_ERROR", 500);
  } finally {
    console.log(
      JSON.stringify({
        method: req.method,
        path: url.pathname,
        user_id: userId,
        duration: Date.now() - started,
      }),
    );
  }
});
