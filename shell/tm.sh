# Terminal Session Manager — `tm` shell command (bash + zsh)
# Manage terminals by folder from the terminal itself: list them, jump to one,
# and reuse an existing terminal instead of opening a duplicate.
#
# Enable by adding this line to ~/.bash_profile (and/or ~/.zshrc):
#   . "/Users/huynhdat/Documents/learning/claude/terminalManagement/shell/tm.sh"
#
# Usage:
#   tm                 pick a folder (fuzzy via fzf if installed, else a menu) → focus/open it
#   tm <query>         pre-filter the picker by a folder name
#   tm ~/dev/foo       reuse the terminal in that folder, or open a new one there
#   tm ls              list every folder with an open terminal
#   tm doctor          diagnostics / permission check

TM_ENGINE="${TM_ENGINE:-/Users/huynhdat/Documents/learning/claude/terminalManagement/assets/tm/cli.mjs}"

tm() {
  local eng="$TM_ENGINE"
  if ! command -v node >/dev/null 2>&1; then
    echo "tm: node not found on PATH" >&2
    return 1
  fi

  case "$1" in
    ls | list)
      node "$eng" list
      return
      ;;
    doctor)
      node "$eng" doctor
      return
      ;;
    -h | --help)
      echo "usage: tm [folder|query] | tm ls | tm doctor"
      return
      ;;
    /* | \~* | ./* | ../*)
      # A concrete path → reuse the terminal there, else open a new one.
      node "$eng" open "$1"
      return
      ;;
  esac

  # Otherwise: pick a folder from the ones that have (or recently had) a terminal.
  local q="$*" pick
  if command -v fzf >/dev/null 2>&1; then
    pick=$(node "$eng" list --paths | fzf --query="$q" --height=40% --reverse \
      --prompt="terminal ▸ " --no-multi) || return
  else
    local paths=() line
    while IFS= read -r line; do paths+=("$line"); done < <(node "$eng" list --paths)
    if [ "${#paths[@]}" -eq 0 ]; then
      echo "No open or recent terminals. Open one with:  tm ~/path/to/folder"
      return
    fi
    echo "Folders with a terminal (or recently used):"
    select pick in "${paths[@]}"; do
      [ -n "$pick" ] && break
    done
  fi

  [ -n "$pick" ] && node "$eng" open "$pick"
}
