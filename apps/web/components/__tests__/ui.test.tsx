// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextAreaField, TextField } from "@/components/ui/field";
import { StatusChip } from "@/components/ui/status-chip";
import { STATUS_INFO } from "@/lib/status";
import type { ProjectStatus } from "@/lib/backend/types";

describe("StatusChip", () => {
  it("shows plain words, not codes, for every status", () => {
    for (const status of Object.keys(STATUS_INFO) as ProjectStatus[]) {
      const { container, unmount } = render(<StatusChip status={status} />);
      const text = container.textContent ?? "";
      expect(text).toBe(STATUS_INFO[status].label);
      expect(text).not.toMatch(/_/);
      unmount();
    }
  });

  it("marks the tone so colour is never the only signal", () => {
    const { container } = render(<StatusChip status="failed" />);
    expect(container.firstElementChild).toHaveAttribute("data-tone", "danger");
    expect(container.textContent).toBe("Stuck");
  });
});

describe("TextField", () => {
  it("connects label, hint and error to the input", () => {
    render(<TextField label="Email" hint="We never share it." error="Enter your email address." />);
    const input = screen.getByLabelText("Email");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const described = input.getAttribute("aria-describedby")!.split(" ");
    expect(described).toHaveLength(2);
    expect(document.getElementById(described[0]!)).toHaveTextContent("We never share it.");
    expect(document.getElementById(described[1]!)).toHaveTextContent("Enter your email address.");
  });

  it("uses a passed id for the label", () => {
    render(<TextField label="Name" id="my-name" />);
    expect(screen.getByLabelText("Name")).toHaveAttribute("id", "my-name");
  });

  it("has no invalid flag when there is no error", () => {
    render(<TextAreaField label="Idea" />);
    expect(screen.getByLabelText("Idea")).not.toHaveAttribute("aria-invalid");
  });
});

describe("Button", () => {
  it("is disabled and tells screen readers it is busy while loading", () => {
    render(
      <Button loading loadingText="Saving…">
        Save
      </Button>,
    );
    const b = screen.getByRole("button");
    expect(b).toBeDisabled();
    expect(b).toHaveTextContent("Saving…");
  });
});

describe("Alert", () => {
  it("announces errors right away", () => {
    render(<Alert tone="danger">Something went wrong.</Alert>);
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong.");
  });
  it("does not announce plain information", () => {
    render(<Alert>Hello</Alert>);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
