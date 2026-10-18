#!/bin/sh
# Install or update seams.
#
#   curl -fsSL https://raw.githubusercontent.com/thehenrymcintosh/seams/main/install.sh | sh
#
# Clones (or updates) seams into ~/.seams, puts a `seams` command in
# ~/.local/bin, and links the skill into ~/.claude/skills. Run it again to
# update. Override the folders with SEAMS_HOME, SEAMS_BIN and SEAMS_SKILLS.
set -eu

REPO="${SEAMS_REPO:-https://github.com/thehenrymcintosh/seams.git}"
HOME_DIR="${SEAMS_HOME:-$HOME/.seams}"
BIN_DIR="${SEAMS_BIN:-$HOME/.local/bin}"
SKILLS_DIR="${SEAMS_SKILLS:-$HOME/.claude/skills}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# 1. Node 22.18 or newer (it runs the .ts files directly) and git.
command -v git >/dev/null 2>&1 || fail "git is not installed."
command -v node >/dev/null 2>&1 || fail "Node is not installed. seams needs Node 22.18 or newer."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || fail "seams needs Node 22.18 or newer; you have $(node -v)."

# 2. Clone, or update an existing clone.
if [ -d "$HOME_DIR/.git" ]; then
  before=$(git -C "$HOME_DIR" rev-parse --short HEAD)
  git -C "$HOME_DIR" pull --ff-only --quiet || fail "could not update $HOME_DIR (local changes?). Fix it with git, then run this again."
  after=$(git -C "$HOME_DIR" rev-parse --short HEAD)
  if [ "$before" = "$after" ]; then say "seams is up to date ($after)"; else say "Updated seams $before -> $after"; fi
elif [ -e "$HOME_DIR" ]; then
  fail "$HOME_DIR exists and is not a seams clone. Move it, or set SEAMS_HOME to another folder."
else
  git clone --quiet --depth 1 "$REPO" "$HOME_DIR"
  say "Installed seams into $HOME_DIR ($(git -C "$HOME_DIR" rev-parse --short HEAD))"
fi

# 3. The command: a small wrapper, so nothing needs root or a global npm folder.
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/seams" <<WRAP
#!/bin/sh
exec node "$HOME_DIR/src/cli.ts" "\$@"
WRAP
chmod +x "$BIN_DIR/seams"

# 4. The skill. Leave anything that isn't our own link alone.
mkdir -p "$SKILLS_DIR"
link="$SKILLS_DIR/seams"
if [ -L "$link" ] || [ ! -e "$link" ]; then
  ln -sfn "$HOME_DIR/skills/seams" "$link"
  skill="linked at $link"
else
  skill="not linked: $link already exists and isn't a link, so it was left alone"
fi

echo
echo "  command  $BIN_DIR/seams"
echo "  skill    $skill"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo; echo "  $BIN_DIR is not on your PATH. Add this to your shell profile:"; echo "    export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
echo
echo "Try it: ask your agent to \"/seams plan <your change>\". Update any time with: seams update"
