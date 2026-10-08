def L: inputs | select(test("\\S")) | (fromjson? // empty) | select(type=="object");
def p: (.payload | objects) // {};
def it: (p.item | objects) // {};
reduce L as $l ({user_messages:0,tool_calls:0,tool_failures:0};
  if $l.type=="event_msg" and ($l|p.type)=="item_completed" then
    (if ($l|it.type)=="UserMessage" then .user_messages += 1 else . end)
    | (if ($l|it.status)=="failed" and (($l|it.type) | IN("CommandExecution","FileChange","McpToolCall","DynamicToolCall","CollabAgentToolCall")) then .tool_failures += 1 else . end)
  elif $l.type=="response_item" and (($l|p.type) | IN("function_call","custom_tool_call","web_search_call","tool_search_call")) then .tool_calls += 1
  else . end)
