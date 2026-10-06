import { useEgg } from './eggs';
import type { MomentId } from './moments';
import { useMoment } from './useMoment';
import { XavierPose, type PoseSize } from './XavierPose';

/** Drop-in: Xavier for a named moment, or nothing when the level says so. */
export function XavierMoment({ id, size = 'spot' }: { id: MomentId; size?: PoseSize }) {
  const moment = useMoment(id);
  const egg = useEgg('pet-xavier');
  if (!moment) return null;
  return <XavierPose moment={moment} size={size} pose={egg.pose} onPress={egg.onTap} />;
}
