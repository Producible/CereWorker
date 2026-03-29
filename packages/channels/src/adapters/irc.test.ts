import { describe, expect, it } from 'vitest';
import { parseIrcLine, extractIrcNick, splitIrcLines } from './irc.js';

describe('IRC protocol helpers', () => {
  describe('parseIrcLine', () => {
    it('parses PING', () => {
      const result = parseIrcLine('PING :irc.libera.chat');
      expect(result.command).toBe('PING');
      expect(result.params).toEqual(['irc.libera.chat']);
      expect(result.prefix).toBeUndefined();
    });

    it('parses PRIVMSG to channel', () => {
      const result = parseIrcLine(':nick!user@host PRIVMSG #channel :hello world');
      expect(result.prefix).toBe('nick!user@host');
      expect(result.command).toBe('PRIVMSG');
      expect(result.params).toEqual(['#channel', 'hello world']);
    });

    it('parses PRIVMSG to user (DM)', () => {
      const result = parseIrcLine(':alice!a@b PRIVMSG cereworker :hi there');
      expect(result.prefix).toBe('alice!a@b');
      expect(result.command).toBe('PRIVMSG');
      expect(result.params).toEqual(['cereworker', 'hi there']);
    });

    it('parses RPL_WELCOME (001)', () => {
      const result = parseIrcLine(':server 001 cereworker :Welcome to the IRC network');
      expect(result.prefix).toBe('server');
      expect(result.command).toBe('001');
      expect(result.params).toEqual(['cereworker', 'Welcome to the IRC network']);
    });

    it('handles messages with no trailing', () => {
      const result = parseIrcLine(':server 433 * cereworker');
      expect(result.command).toBe('433');
      expect(result.params).toEqual(['*', 'cereworker']);
    });

    it('handles messages with colons in trailing text', () => {
      const result = parseIrcLine(':nick!u@h PRIVMSG #ch :link: https://example.com');
      expect(result.params[1]).toBe('link: https://example.com');
    });
  });

  describe('extractIrcNick', () => {
    it('extracts nick from full prefix', () => {
      expect(extractIrcNick('alice!user@host.com')).toBe('alice');
    });

    it('returns bare nick if no ! present', () => {
      expect(extractIrcNick('alice')).toBe('alice');
    });

    it('handles nick with special characters', () => {
      expect(extractIrcNick('CereWorker_01!cw@192.168.1.1')).toBe('CereWorker_01');
    });
  });

  describe('splitIrcLines', () => {
    it('splits multiline text into individual lines', () => {
      expect(splitIrcLines('line1\nline2\nline3')).toEqual(['line1', 'line2', 'line3']);
    });

    it('preserves blank lines as single space', () => {
      expect(splitIrcLines('para1\n\npara2')).toEqual(['para1', ' ', 'para2']);
    });

    it('strips carriage returns', () => {
      expect(splitIrcLines('line1\r\nline2\r\n')).toEqual(['line1', 'line2', ' ']);
    });

    it('handles single line without newlines', () => {
      expect(splitIrcLines('hello world')).toEqual(['hello world']);
    });

    it('preserves code block spacing', () => {
      const code = '```\nfoo\n\nbar\n```';
      const lines = splitIrcLines(code);
      expect(lines).toEqual(['```', 'foo', ' ', 'bar', '```']);
    });
  });
});
