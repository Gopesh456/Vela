// The playground's CUSTOM persistence backend — host code written against the
// documented storage contract (`WidgetStorage` ≡ `WorkspaceStorage`: get/set, sync or
// async), shared by the widget and workspace demo pages. It saves under a `vela-play:`
// namespace through saved.ts: a file the dev server keeps, mirrored in localStorage.
//
// The adapter is the WHOLE integration: with `persist` enabled, both shells persist
// everything themselves — prefs, renderer config, AND user drawings — through it.
import type { WidgetStorage } from '../src/widget';
import { getSaved, setSaved } from './saved';

const PREFIX = 'vela-play:';

/** The one custom storage adapter both demo pages inject via their `storage` option. */
export function playgroundStorage(): WidgetStorage {
    return {
        get: (key) => getSaved(PREFIX + key),
        set: (key, value) => setSaved(PREFIX + key, value),
        remove: (key) => setSaved(PREFIX + key, null),
    };
}
