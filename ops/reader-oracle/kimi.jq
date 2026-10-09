def L: inputs | select(test("\\S")) | (fromjson? // empty) | select(type=="object") | select((.agentId | if . == null then "main" else . end) == "main");
def ev: (.event | objects) // {};
reduce L as $l ({user_messages:0,tool_calls:0,tool_failures:0};
  if $l.type=="context.append_message" then
    (if (((($l.message|objects|.role) // null)=="user") and ((($l.message|objects|.origin|objects|.kind) // null)=="user")) then .user_messages += 1 else . end)
  elif $l.type=="context.append_loop_event" then
    (if ($l|ev.type)=="tool.call" then .tool_calls += 1
     elif ($l|ev.type)=="tool.result" and ((($l|ev.result|objects|.isError) // null)==true) then .tool_failures += 1
     else . end)
  else . end)
