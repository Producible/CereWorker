import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface InputBarProps {
  onSubmit: (text: string) => void;
  onCommand: (command: string, args: string) => void;
  disabled: boolean;
}

export function InputBar({ onSubmit, onCommand, disabled }: InputBarProps) {
  const [input, setInput] = useState('');

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
    <Box borderStyle="single" borderColor={disabled ? 'gray' : 'blue'} paddingX={1}>
      <Text color={disabled ? 'gray' : 'blue'} bold>
        {'> '}
      </Text>
      <Text>{input}</Text>
      {!disabled && <Text color="blue">|</Text>}
    </Box>
  );
}
