def L: inputs | select(test("\\S")) | (fromjson? // empty) | select(type=="object") | select(.isSidechain != true);
def blocks: (.message | objects | .content | arrays) // [];
def okind: ([.origin | objects | .kind] | .[0]) | if . == null then "human" else . end;
def tkind: .turnOrigin | if . == null then "human" else . end;
def txt: (.message | objects | .content | if type=="string" then . elif type=="array" then ([.[] | objects | select(.type=="text") | (.text | strings)] | join("\n")) else "" end) // "";
reduce L as $l ({user_messages:0,tool_calls:0,tool_failures:0};
  if $l.type=="user" then
    ($l | blocks | map(objects | select(.type=="tool_result"))) as $tr
    | .tool_failures += ($tr | map(select(.is_error==true)) | length)
    | if ($tr|length)==0
         and ((($l | .message | objects | .content | type) // "none") | IN("string","array"))
         and $l.isMeta != true and $l.isCompactSummary != true and $l.isVisibleInTranscriptOnly != true
         and $l.interruptedMessageId == null and $l.scheduledTaskId == null
         and (($l | okind) == "human")
         and (($l | tkind) == "human")
         and (($l | txt | test("^\\s*(<local-command-stdout|<local-command-caveat|\\[Request interrupted)")) | not)
      then .user_messages += 1 else . end
  elif $l.type=="assistant" then
    .tool_calls += ($l | blocks | map(objects | select(.type=="tool_use")) | length)
  else . end)
