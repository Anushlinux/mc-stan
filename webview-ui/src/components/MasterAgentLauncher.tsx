import type { MissionControlOrchestratorStatus } from '../../../shared/missionControl.ts';

interface MasterAgentLauncherProps {
  status: MissionControlOrchestratorStatus;
  phaseLabel?: string;
  onClick: () => void;
}

const PIXELS = [
  '000033330000',
  '000366663000',
  '0036cc6cc300',
  '036cccccc630',
  '036cffcc6630',
  '036cffff6630',
  '003666666300',
  '000633336000',
  '003999999300',
  '039999999930',
  '039909909930',
  '003900009300',
];

function pixelColor(cell: string): string {
  if (cell === '3') return 'var(--color-bg-dark)';
  if (cell === '6') return 'var(--color-accent-bright)';
  if (cell === '9') return 'var(--color-warning)';
  if (cell === 'c') return 'var(--terminal-white)';
  if (cell === 'f') return 'var(--color-text)';
  return 'transparent';
}

function getBubbleLabel(status: MissionControlOrchestratorStatus): string {
  if (status === 'planning') return 'Planning';
  if (status === 'provisioning') return 'Provisioning';
  if (status === 'dispatching') return 'Launching';
  if (status === 'running') return 'Monitoring';
  if (status === 'failed') return 'Retry';
  return 'Brief me';
}

export function MasterAgentLauncher({ status, phaseLabel, onClick }: MasterAgentLauncherProps) {
  const isBusy =
    status === 'planning' ||
    status === 'provisioning' ||
    status === 'dispatching' ||
    status === 'running';

  return (
    <button
      type="button"
      className={`absolute left-10 top-12 z-21 border-2 border-border bg-bg/85 px-6 py-6 shadow-pixel transition-colors hover:bg-bg-dark/95 ${isBusy ? 'animate-pulse' : ''}`}
      onClick={onClick}
      aria-label="Open master orchestrator"
    >
      <div className="flex items-center gap-6">
        <div className="grid grid-cols-12 gap-[1px] bg-black/20 p-2">
          {PIXELS.join('')
            .split('')
            .map((cell, index) => (
              <span
                key={index}
                className="h-[4px] w-[4px]"
                style={{ background: pixelColor(cell) }}
              />
            ))}
        </div>
        <div className="min-w-0 text-left">
          <div className="text-2xs uppercase text-text-muted">Master Agent</div>
          <div className="mt-1 text-sm text-white">{getBubbleLabel(status)}</div>
          {phaseLabel ? (
            <div className="mt-1 max-w-[160px] truncate text-2xs text-text-muted">{phaseLabel}</div>
          ) : null}
        </div>
      </div>
    </button>
  );
}
