export type ActivityActor = {
  actor_name?: string | null;
  actor_email?: string | null;
};

export function activityActorLabel(event: ActivityActor) {
  return event.actor_name || event.actor_email || "Actor no registrado";
}
