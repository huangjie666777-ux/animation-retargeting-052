import type {
  AnimationClip,
  LoopMode,
  OverlayLayer,
  PlaybackFrame,
  PlaybackOverlay,
  RigidTransform,
} from './types.js';
import { Skeleton, computeWorldMatrices } from './skeleton.js';
import { evaluatePose } from './pose.js';
import { RootMotion, composeRigid, rigidToMatrix } from './root-motion.js';

function assertRigid(t: RigidTransform, what: string): void {
  if (!t || typeof t !== 'object') throw new Error(what + ' 必须是刚体变换');
  const { translation, rotation } = t;
  if (!Array.isArray(translation) || translation.length !== 3 || !translation.every(Number.isFinite)) {
    throw new Error(what + ' 平移必须是三个有限数');
  }
  if (!Array.isArray(rotation) || rotation.length !== 4 || !rotation.every(Number.isFinite)) {
    throw new Error(what + ' 旋转必须是四个有限数');
  }
  const len = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]);
  if (Math.abs(len - 1) > 1e-3) throw new Error(what + ' 旋转必须是单位四元数');
}

export interface RootMotionPlayerOptions {
  readonly skeleton: Skeleton;
  readonly clip: AnimationClip;
  /** 无父级的顶层根骨骼 ID。 */
  readonly rootBoneId: string;
  /** 播放模式；缺省 'loop'。 */
  readonly mode?: LoopMode;
  /** 初始角色世界刚体变换；缺省单位变换。必须为单位缩放。 */
  readonly initialTransform?: RigidTransform;
}

/**
 * 根运动播放实例。
 *
 * 持有骨架、基础片段、顶层根骨骼、播放模式与初始角色刚体变换，以
 * advance(dt) 按非负有限时间增量推进，状态独立。根运动作用于角色变换，
 * 姿态中的根始终钉在片段起始变换，避免双重运动。
 */
export class RootMotionPlayer {
  readonly skeleton: Skeleton;
  readonly rootBoneId: string;
  readonly mode: LoopMode;
  private readonly motion: RootMotion;
  private initial: RigidTransform;
  private elapsed = 0;
  private finished = false;

  constructor(options: RootMotionPlayerOptions) {
    if (!options || !options.skeleton) throw new Error('播放实例缺少骨架');
    if (!options.clip) throw new Error('播放实例缺少基础片段');
    this.skeleton = options.skeleton;
    this.rootBoneId = options.rootBoneId;
    this.mode = options.mode === 'once' ? 'once' : 'loop';
    this.motion = new RootMotion(options.clip, options.skeleton, options.rootBoneId);
    const initial = options.initialTransform ?? { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };
    assertRigid(initial, '初始角色变换');
    // 确认单位缩放：rigidToMatrix/matrixToRigid 均不含缩放分量，无需额外校验。
    this.initial = initial;
  }

  /** 已累计播放时间（秒）。 */
  get time(): number {
    return this.elapsed;
  }

  /** once 模式是否已停在末帧。 */
  get isFinished(): boolean {
    return this.finished;
  }

  /** 当前角色世界刚体变换。 */
  characterTransform(): RigidTransform {
    const { motion } = this.motion.accumulate(this.elapsed, this.mode);
    return composeRigid(this.initial, motion);
  }

  /** 重置到初始状态（非法参数会抛错且不影响实例）。 */
  reset(transform?: RigidTransform): void {
    const initial = transform ?? this.initial;
    assertRigid(initial, '初始角色变换');
    this.elapsed = 0;
    this.finished = false;
    this.initial = initial;
  }

  /**
   * 以非负有限时间增量推进并求值一帧。非法增量或覆盖层会抛错且不推进状态。
   * 覆盖层可影响根以外的骨骼；根权重恒为 0，不改变根姿态也不贡献根运动。
   */
  advance(dt: number, overlay?: PlaybackOverlay): PlaybackFrame {
    if (typeof dt !== 'number' || !Number.isFinite(dt) || dt < 0) {
      throw new Error('时间增量必须为非负有限数: ' + String(dt));
    }
    const nextElapsed = this.finished ? this.elapsed : this.elapsed + dt;

    const mode = this.mode;
    const accumulated = this.motion.accumulate(nextElapsed, mode);

    // 先构造并校验覆盖层（失败时下面不会提交 elapsed）。
    let overlayLayer: OverlayLayer | undefined;
    if (overlay) {
      if (!overlay.clip) throw new Error('覆盖层缺少片段');
      if (!Number.isFinite(overlay.strength) || overlay.strength < 0 || overlay.strength > 1) {
        throw new Error('覆盖强度必须在 [0, 1]: ' + String(overlay.strength));
      }
      // 顶层根本身恒不被覆盖（下方钉回起始变换），但不能把根以显式 0 注入
      // 遮罩：显式 0 会屏蔽后代继承权重，导致如 mask:{根:1} 时后代也失效。
      const mask = overlay.mask;
      overlayLayer = {
        clip: overlay.clip,
        time: nextElapsed,
        loop: overlay.loop ?? mode,
        strength: overlay.strength,
        mask,
      };
    }

    const pose = evaluatePose(
      this.skeleton,
      { clip: this.motion.clip, time: nextElapsed, loop: mode },
      overlayLayer,
    );
    // 把根钉回片段起始变换：根运动只作用于角色变换，避免双重运动。
    pose.localPose.set(this.rootBoneId, { ...this.motion.startLocal });
    const worldMatrices = computeWorldMatrices(this.skeleton, pose.localPose);

    // 全部求值成功后提交时间状态。
    this.elapsed = nextElapsed;
    this.finished = accumulated.finished;

    const character = composeRigid(this.initial, accumulated.motion);
    return {
      character,
      characterMatrix: rigidToMatrix(character),
      localPose: pose.localPose,
      worldMatrices,
      time: this.elapsed,
      clipTime: accumulated.clipTime,
      finished: this.finished,
    };
  }
}
