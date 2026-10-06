/**
 * Add machines: the invites and "Send a test" from setup's last screen, for
 * whenever they are needed again (a reload during setup lands in the fleet,
 * past that screen). On an authority, in the app it serves itself: the hub's
 * copy makes no invites, as nothing is decided there.
 */
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { Page } from "../components/common";
import { Button } from "../components/ui/button";
import { Group } from "../components/ui/group";
import { useStore } from "../lib/store";
import { CopyCommand } from "./setup/parts";
import { Invite, NotifyTest, SUGGESTED } from "./setup/Done";

export function AddMachinesView() {
  const { session } = useStore();
  const [rows, setRows] = useState(1);
  const taken = session?.nodes ?? [];
  if (session !== null && (!session.authority || session.hub !== undefined))
    return (
      <Page title="Add machines" description="Invites are made on an authority">
        <Group className="flex flex-col gap-2 p-4 text-sm">
          <p className="text-pretty text-muted-foreground">
            {session.hub !== undefined
              ? "This is the app on the hub, which decides nothing. Make an invite on an authority, in its own app (t3-fleet ui --local there) or with:"
              : `${session.self} is not an authority. Make an invite on one, in its app or with:`}
          </p>
          <CopyCommand command="t3-fleet invite <name>" className="max-w-sm" />
        </Group>
      </Page>
    );
  return (
    <Page
      title="Add machines"
      description="Name a machine to make its invite, then run the line on it: it installs T3 Fleet there and joins it to the fleet"
    >
      <ol className="flex max-w-2xl flex-col gap-2.5">
        {Array.from({ length: rows }, (_, i) => (
          <Invite
            key={i}
            index={i}
            placeholder={SUGGESTED.find((n) => !taken.includes(n)) ?? "desktop"}
            taken={taken}
          />
        ))}
      </ol>
      <div>
        <Button size="sm" variant="ghost-muted" onClick={() => setRows((n) => n + 1)}>
          <PlusIcon />
          Another machine
        </Button>
      </div>
      <section aria-labelledby="notify-test" className="flex max-w-2xl flex-col gap-2">
        <h2 id="notify-test" className="font-semibold text-sm">
          Notifications
        </h2>
        <p className="text-pretty text-muted-foreground text-xs leading-5">
          One test alert through the paths the fleet has ([notify]), as{" "}
          <code className="font-mono">t3-fleet notify test</code> sends it.
        </p>
        <div className="-ml-5.5">
          <NotifyTest />
        </div>
      </section>
    </Page>
  );
}
