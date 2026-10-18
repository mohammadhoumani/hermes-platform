import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RoomClient } from "@/components/room/room-client";
import { Alert } from "@/components/ui/alert";
import { getSession } from "@/lib/backend/session";

export const metadata: Metadata = { title: "Project" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ProjectRoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const session = await getSession();
  if (session.status !== "ok") return null;

  let room;
  try {
    room = await session.backend.getRoom(id);
  } catch (e) {
    return (
      <Alert tone="danger" title="We could not open this project">
        {e instanceof Error ? e.message : "Something went wrong. Please try again."}
      </Alert>
    );
  }
  if (!room) notFound(); // also what you get for a project that belongs to somebody else
  return <RoomClient key={room.project.id} snapshot={room} testRole={session.testRole} />;
}
