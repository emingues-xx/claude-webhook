#!/bin/bash
# claude-wrapper.sh - Script wrapper para Claude Code
set -e

INSTRUCTION="$1"
PROJECT_PATH="$2"
OUTPUT_FILE="${3:-/tmp/claude-output-$(date +%s).log}"

if [ -z "$INSTRUCTION" ]; then
    echo "ERROR: Instruction is required"
    exit 1
fi

if [ -z "$PROJECT_PATH" ]; then
    echo "ERROR: Project path is required"
    exit 1
fi

mkdir -p "$PROJECT_PATH"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$OUTPUT_FILE"
}

log "=== Claude Code Wrapper Started ==="
log "Instruction: $INSTRUCTION"
log "Project Path: $PROJECT_PATH"

CLAUDE_CMD=""
for cmd in claude claude-code; do
    if command -v "$cmd" >/dev/null 2>&1; then
        CLAUDE_CMD="$cmd"
        log "Found Claude: $CLAUDE_CMD at $(which $cmd)"
        break
    fi
done

if [ -z "$CLAUDE_CMD" ]; then
    log "ERROR: Claude Code not found in PATH"
    echo "SCRIPT_ERROR: Claude Code not found"
    exit 1
fi

if [ ! -d "$PROJECT_PATH" ] || [ ! -w "$PROJECT_PATH" ]; then
    log "ERROR: Project path issue: $PROJECT_PATH"
    echo "SCRIPT_ERROR: Project path issue"
    exit 1
fi

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
export CLAUDE_SKIP_CONFIRMATION=true
export CLAUDE_AUTO_CONFIRM=yes
export CLAUDE_NONINTERACTIVE=1
export CI=true
export TERM=dumb

cd "$PROJECT_PATH"
log "Changed to directory: $(pwd)"

log "Files before execution:"
ls -la | tee -a "$OUTPUT_FILE"

log "Executing Claude Code..."
START_TIME=$(date +%s)

if echo "2" | "$CLAUDE_CMD" --dangerously-skip-permissions "$INSTRUCTION" 2>&1 | tee -a "$OUTPUT_FILE"; then
    END_TIME=$(date +%s)
    EXECUTION_TIME=$((END_TIME - START_TIME))
    log "Claude Code completed successfully in ${EXECUTION_TIME}s"
    
    log "Files after execution:"
    ls -la | tee -a "$OUTPUT_FILE"
    
    echo "SCRIPT_SUCCESS: Execution completed"
    echo "EXECUTION_TIME: ${EXECUTION_TIME}s"
    echo "OUTPUT_FILE: $OUTPUT_FILE"
    echo "PROJECT_PATH: $PROJECT_PATH"
    exit 0
else
    END_TIME=$(date +%s)
    EXECUTION_TIME=$((END_TIME - START_TIME))
    EXIT_CODE=$?
    
    log "Claude Code failed with exit code: $EXIT_CODE after ${EXECUTION_TIME}s"
    
    if [ $EXIT_CODE -eq 124 ]; then
        echo "SCRIPT_TIMEOUT: Command timed out"
    else
        echo "SCRIPT_ERROR: Command failed with exit code $EXIT_CODE"
    fi
    
    echo "EXECUTION_TIME: ${EXECUTION_TIME}s"
    echo "OUTPUT_FILE: $OUTPUT_FILE"
    exit $EXIT_CODE
fi