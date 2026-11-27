// The chart pages' topbar: a back button to the landing page (index.html, which links both
// pages) at the left end, and the bell opening the Price alerts panel (alerts.ts) in place of
// the built-in alerts log. Imported BEFORE the workspace is built, like every contribution.
import { registerWidgetAction } from '../src/plugin';
import { TOPBAR_DEFAULT_LEFT, TOPBAR_DEFAULT_RIGHT, type TopbarComposition } from '../src/widget';

registerWidgetAction({
    id: 'dev.home',
    target: 'topbar',
    label: 'Back to the playground home',
    icon: 'chevron-left',
    iconOnly: true,
    run: () => location.assign('/'),
});

export const topbar: TopbarComposition = {
    left: ['dev.home', ...TOPBAR_DEFAULT_LEFT],
    right: TOPBAR_DEFAULT_RIGHT.filter((id) => id !== 'alerts'),
};
