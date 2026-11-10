// sunny_app/src/caregiver/useProfileActions.ts
//
// Purpose: Hook behind the caregiver About tab's changes: saving an edited text (an entry's name
// or details, a topic's wording or guidance, a fact's correction), adding an entry, topic or
// fact, confirming a fact the senior said, removing a row and sending the senior a message. Each
// calls one profile.* mutation through callMutation and tracks only what the live lists cannot
// show: an action in flight, a failure (with the server's message) and a notice. A success needs
// no local state because the lists are live subscriptions. An add reports through addOutcome:
// stored as typed (the form may clear; "Already saved." or "Confirmed." when it already existed),
// or already listed with other text, which saves nothing, so it resolves false (the form keeps
// the typed text) and shows why. States are kept by slot: the row ("entry:<id>", "topic:<id>",
// "fact:<id>") or the add form ("add:entry", "add:topic", "add:fact", "add:message"). Every call
// takes a token and writes its slot only while it still owns it, so a call that ends after a
// newer one started cannot overwrite the newer state; the next action in a slot clears its old
// message. The action functions keep their identity between renders.
//
// Last modified: 2026-11-09

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

/** A slot's state: an action running, a failure, or a calm notice. */
export type ProfileActionState =
  | { status: 'working' }
  | { status: 'error'; message: string }
  | { status: 'notice'; message: string };

/** What useProfileActions returns. */
export interface ProfileActions {
  /** Running, failed and notice states by slot; absent for everything else. */
  states: Partial<Record<string, ProfileActionState>>;
  /** Save an edited text; null clears an entry's details. Resolves true when saved. */
  saveField: (target: FieldTarget, value: string | null) => Promise<boolean>;
  /** Add a life profile entry; resolves true when it is stored as typed. */
  addEntry: (entry: { category: LifeCategory; name: string; details?: string }) => Promise<boolean>;
  /** Add a sensitive topic; resolves true when it is stored as typed. */
  addTopic: (topic: { topic: string; guidance: string }) => Promise<boolean>;
  /** Add a caregiver fact; resolves true when it is stored (or now confirmed). */
  addFact: (fact: string) => Promise<boolean>;
  /** Confirm a fact the senior said. */
  verifyFact: (id: FactId) => Promise<boolean>;
  /** Remove a row. */
  remove: (target: RowRef) => Promise<boolean>;
  /** Send the senior a text message; resolves true when sent. */
  sendMessage: (body: string) => Promise<boolean>;
}

/** The outcome of a call that needs no message: done, and the form may clear. */
const DONE: AddOutcome = { clear: true, message: null };

/**
 * purpose: Track and perform the About tab's changes for one household.
 * @param householdId: (HouseholdId) The household.
 * @return: (ProfileActions) The slot states and the action functions.
 */
export function useProfileActions(householdId: HouseholdId): ProfileActions {
  const [states, setStates] = useState<Partial<Record<string, ProfileActionState>>>({});
  /** The token of the latest call per slot; a call writes the slot only while it holds it. */
  const tokensRef = useRef<Partial<Record<string, number>>>({});
  const nextTokenRef = useRef(0);

  /**
   * purpose: Run one mutation in a slot: show it working, then show the outcome's message (or
   *          clear the slot), or show the error. A newer call in the slot wins.
   * @param slot: (string) The row or form the action belongs to.
   * @param call: (() => Promise<R>) The mutation call.
   * @param outcome: ((result: R) => AddOutcome, optional) What a successful result means: whether
   *        the caller may treat it as done, and a message; by default done with no message.
   * @return: (Promise<boolean>) True when the call succeeded and its outcome is done; never
   *          rejects.
   */
  const run = useCallback(
    async <R>(
      slot: string,
      call: () => Promise<R>,
      outcome: (result: R) => AddOutcome = () => DONE,
    ): Promise<boolean> => {
      const token = ++nextTokenRef.current;
      tokensRef.current[slot] = token;

      /**
       * purpose: Write the slot unless a newer call owns it.
       * @param state: (ProfileActionState | undefined) The new state; undefined clears it.
       * @return: (void)
       */
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

  /**
   * purpose: Save an edited text through the mutation for its kind; the fact correction also
   *          confirms the fact. Shown on the text's row.
   * @param target: (FieldTarget) The text being saved.
   * @param value: (string | null) The trimmed text; null clears an entry's details.
   * @return: (Promise<boolean>) True when saved; never rejects.
   */
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

  /**
   * purpose: Add a life profile entry (the "add:entry" slot).
   * @param entry: ({ category, name, details? }) The entry.
   * @return: (Promise<boolean>) True when stored as typed; false when it failed or the name is
   *          already listed with other details (nothing saved); never rejects.
   */
  const addEntry = useCallback(
    (entry: { category: LifeCategory; name: string; details?: string }): Promise<boolean> =>
      run(
        'add:entry',
        () => callMutation(api.profile.addEntry, { householdId, ...entry }),
        (result) => addOutcome('entry', result, entry.name),
      ),
    [householdId, run],
  );

  /**
   * purpose: Add a sensitive topic (the "add:topic" slot).
   * @param topic: ({ topic, guidance }) The topic and how to handle it.
   * @return: (Promise<boolean>) True when stored as typed; false when it failed or the topic
   *          already has other guidance (nothing saved); never rejects.
   */
  const addTopic = useCallback(
    (topic: { topic: string; guidance: string }): Promise<boolean> =>
      run(
        'add:topic',
        () => callMutation(api.profile.addTopic, { householdId, ...topic }),
        (result) => addOutcome('topic', result, topic.topic),
      ),
    [householdId, run],
  );

  /**
   * purpose: Add a fact the caregiver knows, verified at once (the "add:fact" slot); a fact the
   *          senior had said is confirmed instead.
   * @param fact: (string) The fact.
   * @return: (Promise<boolean>) True when stored or confirmed; never rejects.
   */
  const addFact = useCallback(
    (fact: string): Promise<boolean> =>
      run(
        'add:fact',
        () => callMutation(api.profile.addFact, { householdId, fact }),
        (result) => addOutcome('fact', result, fact),
      ),
    [householdId, run],
  );

  /**
   * purpose: Confirm a fact the senior said (shown on the fact's row).
   * @param id: (FactId) The fact.
   * @return: (Promise<boolean>) True when confirmed; never rejects.
   */
  const verifyFact = useCallback(
    (id: FactId): Promise<boolean> =>
      run(rowKey({ kind: 'fact', id }), () =>
        callMutation(api.profile.verifyFact, { householdId, factId: id }),
      ),
    [householdId, run],
  );

  /**
   * purpose: Remove an entry, topic or fact (shown on its row).
   * @param target: (RowRef) The row.
   * @return: (Promise<boolean>) True when removed; never rejects.
   */
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

  /**
   * purpose: Send the senior a text message (the "add:message" slot).
   * @param body: (string) The message.
   * @return: (Promise<boolean>) True when sent; never rejects.
   */
  const sendMessage = useCallback(
    (body: string): Promise<boolean> =>
      run('add:message', () => callMutation(api.profile.sendMessage, { householdId, body })),
    [householdId, run],
  );

  return { states, saveField, addEntry, addTopic, addFact, verifyFact, remove, sendMessage };
}
