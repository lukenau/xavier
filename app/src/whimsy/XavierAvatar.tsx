// Xavier's face on a small LED tile, for liveness spots (Home card, headers).
// Busy → the scan band runs; down → the screen dims to his dozing pose.
import { useWhimsy } from './level';
import { XavierTile } from './XavierPose';

export type AvatarState = 'idle' | 'busy' | 'down';

export function XavierAvatar({ size = 44, state = 'idle' }: { size?: number; state?: AvatarState }) {
  const { motion } = useWhimsy();
  return (
    <XavierTile
      pose={state === 'down' ? 'asleep' : 'portrait'}
      size={size}
      motion={state === 'busy' && motion ? 'scan' : 'still'}
      animate={false}
      dim={state === 'down'}
    />
  );
}
