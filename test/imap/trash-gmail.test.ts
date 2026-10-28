import { testMailbox } from "./harness";
import { trashChecks } from "./trash-checks";
trashChecks(testMailbox({ gmail: true }));
