import { useCallback, useEffect, useRef, useState } from 'react';

import { callMutation, toBackendError } from '../backend/api';
import { api, type TaskInstanceId } from '../backend/convexApi';
import { alreadyDoneMessage } from './format';

export const ERROR_CLEAR_MS = 5000;

export type TaskActionState =
  | { status: 'claiming' }
  | { status: 'marking' }
  | { status: 'undoing' }
  | { status: 'reopening' }
  | { status: 'saving' }
  | { status: 'error'; message: string };

export interface TaskActions {
  actions: Partial<Record<string, TaskActionState>>;
  claim: (instanceId: TaskInstanceId) => Promise<void>;
  markDone: (instanceId: TaskInstanceId) => Promise<boolean>;
  undoMarkDone: (instanceId: TaskInstanceId) => Promise<void>;
  reopen: (instanceId: TaskInstanceId) => Promise<void>;
  saveNote: (instanceId: TaskInstanceId, note: string | undefined) => Promise<boolean>;
}

export function useTaskActions(userId: string | null): TaskActions {
  const [actions, setActions] = useState<Partial<Record<string, TaskActionState>>>({});
  const tokensRef = useRef<Partial<Record<string, number>>>({});
  const nextTokenRef = useRef(0);
  const timersRef = useRef<Partial<Record<string, ReturnType<typeof setTimeout>>>>({});

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      Object.values(timers).forEach((timer) => clearTimeout(timer));
    };
  }, []);

  const setAction = useCallback(
    (instanceId: TaskInstanceId, state: TaskActionState | undefined): void => {
      setActions((prev) => {
        if (state !== undefined) return { ...prev, [instanceId]: state };
        if (!(instanceId in prev)) return prev;
        const next = { ...prev };
        delete next[instanceId];
        return next;
      });
    },
    [],
  );

  const run = useCallback(
    async <R>(
      instanceId: TaskInstanceId,
      working: TaskActionState,
      call: () => Promise<R>,
      notice: (result: R) => string | null = () => null,
    ): Promise<boolean> => {
      const token = ++nextTokenRef.current;
      tokensRef.current[instanceId] = token;
      clearTimeout(timersRef.current[instanceId]);
      delete timersRef.current[instanceId];
      setAction(instanceId, working);

      const finish = (state: TaskActionState | undefined): void => {
        if (tokensRef.current[instanceId] !== token) return;
        setAction(instanceId, state);
        if (state?.status !== 'error') return;
        timersRef.current[instanceId] = setTimeout(() => {
          if (tokensRef.current[instanceId] === token) setAction(instanceId, undefined);
          delete timersRef.current[instanceId];
        }, ERROR_CLEAR_MS);
      };

      try {
        const message = notice(await call());
        finish(message === null ? undefined : { status: 'error', message });
        return message === null;
      } catch (e) {
        finish({ status: 'error', message: toBackendError(e).message });
        return false;
      }
    },
    [setAction],
  );

  const claim = useCallback(
    async (instanceId: TaskInstanceId): Promise<void> => {
      await run(instanceId, { status: 'claiming' }, () =>
        callMutation(api.instances.claimTaskInstance, { instanceId }),
      );
    },
    [run],
  );

  const markDone = useCallback(
    (instanceId: TaskInstanceId): Promise<boolean> =>
      run(
        instanceId,
        { status: 'marking' },
        () => callMutation(api.instances.confirmTaskInstance, { instanceId, via: 'caregiver' }),
        (task) => alreadyDoneMessage(task.confirmedBy, userId),
      ),
    [run, userId],
  );

  const undoMarkDone = useCallback(
    async (instanceId: TaskInstanceId): Promise<void> => {
      await run(instanceId, { status: 'undoing' }, () =>
        callMutation(api.instances.undoResolve, { instanceId }),
      );
    },
    [run],
  );

  const reopen = useCallback(
    async (instanceId: TaskInstanceId): Promise<void> => {
      await run(instanceId, { status: 'reopening' }, () =>
        callMutation(api.instances.reopenTaskInstance, { instanceId }),
      );
    },
    [run],
  );

  const saveNote = useCallback(
    (instanceId: TaskInstanceId, note: string | undefined): Promise<boolean> =>
      run(instanceId, { status: 'saving' }, () =>
        callMutation(api.instances.setTaskNote, { instanceId, note }),
      ),
    [run],
  );

  return { actions, claim, markDone, undoMarkDone, reopen, saveNote };
}
