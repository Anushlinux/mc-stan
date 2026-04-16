import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { Readable } from 'node:stream';

import * as vscode from 'vscode';

interface VoiceDictationManagerOptions {
  extensionPath: string;
  onText: (text: string) => Promise<void>;
}

interface VoiceDictationEvent {
  type: 'ready' | 'listening' | 'text' | 'error' | 'stopped';
  text?: string;
  message?: string;
}

interface ExecFileAsyncOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const APP_NAME = 'PixelAgentsVoiceDictation';
const APP_BUNDLE_ID = 'com.pixelagents.voicedictation';

function execFileAsync(
  command: string,
  args: string[],
  options?: ExecFileAsyncOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options ?? {}, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function normalizeTranscript(transcript: string): string {
  return transcript.trim().replace(/\s+/g, ' ');
}

function formatTranscriptForTyping(transcript: string): string {
  const text = normalizeTranscript(transcript);
  if (!text) {
    return '';
  }
  return /\s$/.test(text) ? text : `${text} `;
}

export class VoiceDictationManager {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private stdoutReader: readline.Interface | null = null;
  private stderrReader: readline.Interface | null = null;
  private statusItem: vscode.StatusBarItem;
  private isStopping = false;
  private startPromise: Promise<void> | null = null;

  constructor(private readonly options: VoiceDictationManagerOptions) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1100);
    this.statusItem.name = 'Pixel Agents Voice Dictation';
    this.statusItem.command = 'pixel-agents.toggleVoiceDictation';
  }

  async toggle(): Promise<boolean> {
    if (process.platform !== 'darwin') {
      return false;
    }

    if (this.child) {
      this.stop();
      return true;
    }

    if (this.startPromise) {
      await this.startPromise;
      return true;
    }

    this.startPromise = this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }

    return true;
  }

  dispose(): void {
    this.stop();
    this.statusItem.dispose();
  }

  private async start(): Promise<void> {
    this.updateStatus('$(tools) Preparing voice dictation', 'Compiling native dictation helper');

    try {
      const executablePath = await this.ensureNativeHelper();
      const child = spawn(executablePath, [], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.child = child;
      this.isStopping = false;
      this.attachReaders(child);
      this.updateStatus('$(mic-filled) Voice dictation', 'Listening for speech');

      child.once('exit', (code, signal) => {
        const expectedStop =
          this.isStopping || code === 0 || signal === 'SIGINT' || signal === 'SIGTERM';
        this.cleanupChild();
        if (expectedStop) {
          this.statusItem.hide();
          return;
        }

        this.statusItem.hide();
        void vscode.window.showErrorMessage(
          `Pixel Agents: Voice dictation stopped unexpectedly${code !== null ? ` (exit ${code})` : ''}.`,
        );
      });
    } catch (error) {
      this.cleanupChild();
      this.statusItem.hide();
      const reason = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Pixel Agents: Failed to start macOS voice dictation. ${reason}`,
      );
    }
  }

  private stop(): void {
    if (!this.child) {
      this.statusItem.hide();
      return;
    }

    this.isStopping = true;
    this.updateStatus('$(mic) Voice off', 'Voice dictation stopped');
    this.child.kill('SIGINT');
  }

  private attachReaders(child: ChildProcessByStdio<null, Readable, Readable>): void {
    this.stdoutReader = readline.createInterface({ input: child.stdout });
    this.stdoutReader.on('line', (line) => {
      void this.handleStdoutLine(line);
    });

    this.stderrReader = readline.createInterface({ input: child.stderr });
    this.stderrReader.on('line', (line) => {
      console.error('[Pixel Agents] Voice dictation stderr:', line);
    });
  }

  private async handleStdoutLine(line: string): Promise<void> {
    let event: VoiceDictationEvent;
    try {
      event = JSON.parse(line) as VoiceDictationEvent;
    } catch {
      console.warn('[Pixel Agents] Voice dictation emitted invalid JSON:', line);
      return;
    }

    if (event.type === 'ready' || event.type === 'listening') {
      this.updateStatus('$(mic-filled) Voice dictation', 'Listening for speech');
      return;
    }

    if (event.type === 'stopped') {
      this.statusItem.hide();
      return;
    }

    if (event.type === 'error') {
      const message = event.message ?? 'Voice dictation failed.';
      this.updateStatus('$(error) Voice dictation', message);
      void vscode.window.showErrorMessage(`Pixel Agents: ${message}`);
      return;
    }

    if (event.type === 'text') {
      const text = formatTranscriptForTyping(event.text ?? '');
      if (!text) {
        return;
      }
      await this.options.onText(text);
    }
  }

  private updateStatus(text: string, tooltip: string): void {
    this.statusItem.text = text;
    this.statusItem.tooltip = tooltip;
    this.statusItem.show();
  }

  private cleanupChild(): void {
    this.stdoutReader?.close();
    this.stderrReader?.close();
    this.stdoutReader = null;
    this.stderrReader = null;
    this.child = null;
    this.isStopping = false;
  }

  private async ensureNativeHelper(): Promise<string> {
    const sourcePath = this.resolveSourcePath();
    const appPath = path.join(os.homedir(), '.pixel-agents', 'native', `${APP_NAME}.app`);
    const contentsPath = path.join(appPath, 'Contents');
    const executablePath = path.join(contentsPath, 'MacOS', APP_NAME);
    const infoPlistPath = path.join(contentsPath, 'Info.plist');
    const cacheRoot = path.join(os.homedir(), '.pixel-agents', 'native', 'cache');

    const sourceStat = fs.statSync(sourcePath);
    const executableExists = fs.existsSync(executablePath);
    const executableMtime = executableExists ? fs.statSync(executablePath).mtimeMs : 0;
    const shouldRebuild =
      !executableExists || !fs.existsSync(infoPlistPath) || sourceStat.mtimeMs > executableMtime;

    if (!shouldRebuild) {
      return executablePath;
    }

    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.mkdirSync(cacheRoot, { recursive: true });
    fs.writeFileSync(infoPlistPath, this.buildInfoPlist(), 'utf-8');

    await execFileAsync(
      '/usr/bin/swiftc',
      [
        '-O',
        '-parse-as-library',
        '-framework',
        'Speech',
        '-framework',
        'AVFoundation',
        sourcePath,
        '-o',
        executablePath,
      ],
      {
        env: {
          ...process.env,
          SWIFT_MODULE_CACHE_PATH: path.join(cacheRoot, 'swift-module-cache'),
          CLANG_MODULE_CACHE_PATH: path.join(cacheRoot, 'clang-module-cache'),
        },
      },
    );

    fs.chmodSync(executablePath, 0o755);
    return executablePath;
  }

  private resolveSourcePath(): string {
    const candidates = [
      path.join(this.options.extensionPath, 'dist', 'native', 'macos', `${APP_NAME}.swift`),
      path.join(this.options.extensionPath, 'native', 'macos', `${APP_NAME}.swift`),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    throw new Error('Native macOS dictation source is missing from the extension bundle.');
  }

  private buildInfoPlist(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Pixel Agents Voice Dictation</string>
  <key>CFBundleExecutable</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>${APP_BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>Pixel Agents uses the microphone to transcribe speech into the active VS Code input.</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>Pixel Agents uses speech recognition to turn your voice into text inside VS Code.</string>
</dict>
</plist>
`;
  }
}
