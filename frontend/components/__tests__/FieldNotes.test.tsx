import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { FieldNotes } from "@/components/FieldNotes";
import { updateDraft } from "@/lib/indexeddb";
import { getOrCreateDraftId } from "@/lib/draft";

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, vars?: Record<string, unknown>) =>
      vars && Object.keys(vars).length ? `${key} ${Object.values(vars).join(" ")}` : key;
    t.rich = (key: string) => key;
    return t;
  },
  useLocale: () => "en",
}));

jest.mock("@/lib/indexeddb", () => ({ updateDraft: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@/lib/draft", () => ({ getOrCreateDraftId: jest.fn(() => "draft-1") }));

const mockUpdateDraft = updateDraft as jest.Mock;

beforeEach(() => {
  mockUpdateDraft.mockReset().mockResolvedValue(undefined);
  (getOrCreateDraftId as jest.Mock).mockReturnValue("draft-1");
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("FieldNotes", () => {
  it("persists the note to the draft after the officer stops typing", async () => {
    render(<FieldNotes />);
    fireEvent.change(screen.getByTestId("field-notes"), {
      target: { value: "Approx 1.5 acres of paddy affected, east section of field." },
    });

    // Nothing written yet — a write per keystroke would thrash IndexedDB.
    expect(mockUpdateDraft).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(700);
    });
    expect(mockUpdateDraft).toHaveBeenCalledWith("draft-1", {
      field_notes: "Approx 1.5 acres of paddy affected, east section of field.",
    });
  });

  it("collapses a burst of keystrokes into a single write", async () => {
    render(<FieldNotes />);
    const box = screen.getByTestId("field-notes");
    fireEvent.change(box, { target: { value: "a" } });
    fireEvent.change(box, { target: { value: "ab" } });
    fireEvent.change(box, { target: { value: "abc" } });

    await act(async () => {
      jest.advanceTimersByTime(700);
    });
    expect(mockUpdateDraft).toHaveBeenCalledTimes(1);
    expect(mockUpdateDraft).toHaveBeenCalledWith("draft-1", { field_notes: "abc" });
  });

  it("does not write back the value it was seeded with", async () => {
    render(<FieldNotes initialValue="already saved" />);
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockUpdateDraft).not.toHaveBeenCalled();
  });

  it("notifies the host only with text that actually landed", async () => {
    const onSaved = jest.fn();
    render(<FieldNotes onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId("field-notes"), { target: { value: "east paddy" } });

    await act(async () => {
      jest.advanceTimersByTime(700);
    });
    expect(onSaved).toHaveBeenCalledWith("east paddy");
  });

  it("keeps the officer's text on screen when the write fails, and warns quietly", async () => {
    mockUpdateDraft.mockRejectedValue(new Error("quota exceeded"));
    const onSaved = jest.fn();
    render(<FieldNotes onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId("field-notes"), { target: { value: "east paddy" } });

    await act(async () => {
      jest.advanceTimersByTime(700);
    });

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("fieldNotes.saveError"));
    // The text is not lost, and the host is never told a failed write succeeded.
    expect(screen.getByTestId("field-notes")).toHaveValue("east paddy");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("caps the note length so it stays a note", () => {
    render(<FieldNotes />);
    expect(screen.getByTestId("field-notes")).toHaveAttribute("maxlength", "500");
  });
});
