# Managed by the agent-stuff Codex launcher installer.
# Move agent-bin to the front, removing inherited duplicates. It contains no
# plain codex command: codexr is explicit, and native codex remains native.
_agent_bin="${AGENT_BIN_DIR:-$HOME/.local/agent-bin}"
_agent_path_rest=$PATH
_agent_path="$_agent_bin"
while [[ "$_agent_path_rest" == *:* ]]; do
  _agent_path_part=${_agent_path_rest%%:*}
  _agent_path_rest=${_agent_path_rest#*:}
  [[ "$_agent_path_part" == "$_agent_bin" ]] || _agent_path+=":$_agent_path_part"
done
[[ "$_agent_path_rest" == "$_agent_bin" ]] || _agent_path+=":$_agent_path_rest"
export PATH="$_agent_path"
unset _agent_bin _agent_path_rest _agent_path _agent_path_part
