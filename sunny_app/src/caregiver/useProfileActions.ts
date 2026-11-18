import { useCallback, useRef, useState } from 'react';

import { callMutation, toBackendError } from '../backend/api';
import { api, type FactId, type HouseholdId } from '../backend/convexApi';
import {
  addOutcome,
  fieldRowKey,
  rowKey,
  type AddOutcome,
  type FieldTarget,
  type LifeCategory,
  type RowRef,
} from './aboutFormat';

export type ProfileActionState =
  | { status: 'working' }
  | { status: 'error'; message: string }
  | { status: 'notice'; message: string };

export interface ProfileActions {
  states: Partial<Record<string, ProfileActionState>>;
  saveField: (target: FieldTarget, value: string | null) => Promise<boolean>;
  addEntry: (entry: { category: LifeCategory; name: string; details?: string }) => Promise<boolean>;
  addTopic: (topic: { topic: string; guidance: string }) => Promise<boolean>;
  addFact: (fact: string) => Promise<boolean>;
  verifyFact: (id: FactId) => Promise<boolean>;
  remove: (target: RowRef) => Promise<boolean>;
  sendMessage: (body: string) => Promise<boolean>;
}

const DONE: AddOutcome = { clear: true, message: null };

export function useProfileActions(householdId: HouseholdId): ProfileActions {
  const [states, setStates] = useState<Partial<Record<string, ProfileActionState>>>({});
  const tokensRef = useRef<Partial<Record<string, number>>>({});
  const nextTokenRef = useRef(0);

  const run = useCallback(
    async <R>(
      slot: string,
      call: () => Promise<R>,
      outcome: (result: R) => AddOutcome = () => DONE,
    ): Promise<boolean> => {
      const token = ++nextTokenRef.current;
      tokensRef.current[slot] = token;

      const write = (state: ProfileActionState | undefined): void => {
        if (tokensRef.current[slot] !== token) return;
        setStates((prev) => {
          const next = { ...prev };
          if (state === undefined) delete next[slot];
          else next[slot] = state;
          return next;
        });
      };

      write({ status: 'working' });
      try {
        const { clear, message } = outcome(await call());
        write(message === null ? undefined : { status: message.status, message: message.text });
        return clear;
      } catch (e) {
        write({ status: 'error', message: toBackendError(e).message });
        return false;
      }
    },
    [],
  );

  const saveField = useCallback(
    (target: FieldTarget, value: string | null): Promise<boolean> =>
      run(fieldRowKey(target), () => {
        switch (target.kind) {
          case 'entryName':
            return callMutation(api.profile.updateEntry, {
              householdId,
              entryId: target.id,
              name: value ?? '',
            });
          case 'entryDetails':
            return callMutation(api.profile.updateEntry, {
              householdId,
              entryId: target.id,
              details: value,
            });
          case 'topic':
            return callMutation(api.profile.updateTopic, {
              householdId,
              topicId: target.id,
              topic: value ?? '',
            });
          case 'guidance':
            return callMutation(api.profile.updateTopic, {
              householdId,
              topicId: target.id,
              guidance: value ?? '',
            });
          case 'fact':
            return callMutation(api.profile.correctFact, {
              householdId,
              factId: target.id,
              fact: value ?? '',
            });
        }
      }),
    [householdId, run],
  );

  const addEntry = useCallback(
    (entry: { category: LifeCategory; name: string; details?: string }): Promise<boolean> =>
      run(
        'add:entry',
        () => callMutation(api.profile.addEntry, { householdId, ...entry }),
        (result) => addOutcome('entry', result, entry.name),
      ),
    [householdId, run],
  );

  const addTopic = useCallback(
    (topic: { topic: string; guidance: string }): Promise<boolean> =>
      run(
        'add:topic',
        () => callMutation(api.profile.addTopic, { householdId, ...topic }),
        (result) => addOutcome('topic', result, topic.topic),
      ),
    [householdId, run],
  );

  const addFact = useCallback(
    (fact: string): Promise<boolean> =>
      run(
        'add:fact',
        () => callMutation(api.profile.addFact, { householdId, fact }),
        (result) => addOutcome('fact', result, fact),
      ),
    [householdId, run],
  );

  const verifyFact = useCallback(
    (id: FactId): Promise<boolean> =>
      run(rowKey({ kind: 'fact', id }), () =>
        callMutation(api.profile.verifyFact, { householdId, factId: id }),
      ),
    [householdId, run],
  );

  const remove = useCallback(
    (target: RowRef): Promise<boolean> =>
      run(rowKey(target), () => {
        switch (target.kind) {
          case 'entry':
            return callMutation(api.profile.removeEntry, { householdId, entryId: target.id });
          case 'topic':
            return callMutation(api.profile.removeTopic, { householdId, topicId: target.id });
          case 'fact':
            return callMutation(api.profile.removeFact, { householdId, factId: target.id });
        }
      }),
    [householdId, run],
  );

  const sendMessage = useCallback(
    (body: string): Promise<boolean> =>
      run('add:message', () => callMutation(api.profile.sendMessage, { householdId, body })),
    [householdId, run],
  );

  return { states, saveField, addEntry, addTopic, addFact, verifyFact, remove, sendMessage };
}
