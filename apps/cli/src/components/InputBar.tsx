import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { SLASH_COMMANDS } from '../commands.js';

interface InputBarProps {
  onSubmit: (text: string) => void;
  onCommand: (command: string, args: string) => void;
  disabled: boolean;
}

export function InputBar({ onSubmit, onCommand, disabled }: InputBarProps) {
  const [input, setInput] = useState('');

  const { suggestion, hint, allMatches } = useMemo(() => {
    if (!input.startsWith('/')) return { suggestion: '', hint: '', allMatches: [] };

    // Just "/" typed — show all commands
    if (input === '/') {
      return { suggestion: '', hint: '', allMatches: SLASH_COMMANDS };
    }

    // Filter matching commands
    const matches = SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(input) && cmd.name !== input);
    if (matches.length === 1) {
      return {
        suggestion: matches[0].name.slice(input.length),
        hint: matches[0].hint,
        allMatches: [],
      };
    }
    if (matches.length > 1) {
      return { suggestion: '', hint: '', allMatches: matches };
    }

    // Exact match — show hint only
    const exact = SLASH_COMMANDS.find((cmd) => cmd.name === input);
    if (exact) {
      return { suggestion: '', hint: exact.hint, allMatches: [] };
    }

    return { suggestion: '', hint: '', allMatches: [] };
  }, [input]);

  useInput((ch, key) => {
    if (key.return) {
      const trimmed = input.trim();
      if (!trimmed) return;

      // /stop always works, even during streaming
      if (trimmed === '/stop') {
        onCommand('stop', '');
        setInput('');
        return;
      }

      if (disabled) return;

      if (trimmed.startsWith('/')) {
        const spaceIdx = trimmed.indexOf(' ');
        const command = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
        const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1);
        onCommand(command, args);
      } else {
        onSubmit(trimmed);
      }
      setInput('');
      return;
    }

    if (key.tab && suggestion) {
      setInput((prev) => prev + suggestion);
      return;
    }

    // Tab with multiple matches — complete to common prefix
    if (key.tab && allMatches.length > 1) {
      const names = allMatches.map((m) => m.name);
      let common = names[0];
      for (const name of names.slice(1)) {
        while (!name.startsWith(common)) {
          common = common.slice(0, -1);
        }
      }
      if (common.length > input.length) {
        setInput(common);
      }
      return;
    }

    if (disabled && input.trim() !== '/sto') {
      // Allow typing /stop even while disabled, block other input
      if (ch && !key.ctrl && !key.meta) {
        const next = input + ch;
        if ('/stop'.startsWith(next.trim())) {
          setInput(next);
        }
        return;
      }
    }

    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }

    if (ch && !key.ctrl && !key.meta) {
      setInput((prev) => prev + ch);
    }
  });

  return (
    <Box flexDirection="column">
      {/* Command list when "/" is typed */}
      {allMatches.length > 0 && (
        <Box paddingX={2} flexDirection="row" flexWrap="wrap">
          {allMatches.map((cmd) => (
            <Box key={cmd.name} marginRight={1}>
              <Text dimColor>{cmd.name}</Text>
            </Box>
          ))}
        </Box>
      )}
      <Box borderStyle="single" borderColor={disabled ? 'gray' : 'blue'} paddingX={1}>
        <Text color={disabled ? 'gray' : 'blue'} bold>
          {'> '}
        </Text>
        <Text>{input}</Text>
        {suggestion && <Text dimColor>{suggestion}</Text>}
        {hint && <Text dimColor> — {hint}</Text>}
        {!disabled && !suggestion && !hint && allMatches.length === 0 && <Text color="blue">|</Text>}
      </Box>
    </Box>
  );
}
