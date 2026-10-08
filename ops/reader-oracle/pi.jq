def L: inputs | select(test("\\S")) | (fromjson? // empty) | select(type=="object");
def m: (.message | objects) // {};
reduce L as $l ({user_messages:0,tool_calls:0,tool_failures:0};
  if $l.type=="message" then
    ($l|m.role) as $r
    | if $r=="user" then .user_messages += 1
      elif $r=="assistant" then .tool_calls += (($l|m.content|arrays) // [] | map(objects | select(.type=="toolCall")) | length)
      elif $r=="toolResult" then (if ($l|m.isError)==true then .tool_failures += 1 else . end)
      else . end
  else . end)
