/**
 * The evidence gallery, shown on the administrator's case file, the officer's assessment screen
 * and the Divisional Secretariat's payment screen.
 *
 * WHAT CHANGED AND WHY THESE TESTS CHANGED WITH IT. This component used to be a placeholder that
 * explained why there were no photographs: none had ever reached the server (PO decision
 * 2026-07-13, backend pipeline absent). Migration 038 built that pipeline, so the explanation is
 * no longer true and is no longer what the screen says. What matters now is that the photographs
 * appear, that each is attributed to whoever took it, and that a photograph which cannot be
 * displayed says so rather than disappearing — an approver must never mistake a broken tile for a
 * case that had no evidence.
 */
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { PhotoGallery } from "@/components/admin/PhotoGallery";
import { listCasePhotos } from "@/lib/casePhotos";

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }));
jest.mock("@/lib/casePhotos", () => ({ listCasePhotos: jest.fn() }));

// next/image needs no network here; render it as a plain img so `src` and `alt` are assertable.
// `unoptimized` is a next/image directive, not a DOM attribute -- dropping it here keeps React
// from warning about an unknown attribute on every render.
jest.mock("next/image", () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  default: ({ unoptimized, ...props }: Record<string, unknown>) => (
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    <img {...(props as { alt: string })} />
  ),
}));

const mockList = listCasePhotos as jest.Mock;

const citizenPhoto = {
  id: 1, source: "citizen" as const, content_type: "image/jpeg", byte_size: 1000,
  created_at: "2026-09-28T08:00:00Z", url: "https://storage.example/signed/citizen.jpg",
};
const officerPhoto = {
  id: 2, source: "officer" as const, content_type: "image/jpeg", byte_size: 2000,
  created_at: "2026-09-28T09:00:00Z", url: "https://storage.example/signed/officer.jpg",
};

beforeEach(() => {
  mockList.mockReset().mockResolvedValue({ ok: true, photos: [citizenPhoto, officerPhoto] });
});

it("shows both photographs and says who took each", async () => {
  // The distinction decides how much weight the approver gives a photograph: the officer's was taken
  // at the site, the family's is their own account of the damage.
  render(<PhotoGallery caseRef="HEC-2026-0295" />);
  await screen.findByTestId("photo-gallery");
  expect(screen.getByTestId("photo-source-citizen")).toHaveTextContent("photo.source.citizen");
  expect(screen.getByTestId("photo-source-officer")).toHaveTextContent("photo.source.officer");
  expect(screen.getByText("photo.sourceNote")).toBeInTheDocument();
});

it("renders each signed URL exactly as the server issued it", async () => {
  // The URLs are short-lived credentials against a private bucket. Rewriting one (through the
  // image optimizer, say) would strip its signature and break every tile.
  render(<PhotoGallery caseRef="HEC-2026-0295" />);
  const images = await screen.findAllByRole("img");
  expect(images.map((i) => i.getAttribute("src"))).toEqual([citizenPhoto.url, officerPhoto.url]);
});

it("fetches by whatever reference it is given", async () => {
  render(<PhotoGallery caseRef="4f1c1a5e-2b7e-4c3a-9d2e-0a1b2c3d4e5f" />);
  await waitFor(() => expect(mockList).toHaveBeenCalledWith("4f1c1a5e-2b7e-4c3a-9d2e-0a1b2c3d4e5f"));
});

it("marks a photograph that could not be signed instead of dropping it", async () => {
  // A dropped tile would read as "this case had one photograph", which is a different and false
  // statement about the evidence.
  mockList.mockResolvedValue({ ok: true, photos: [citizenPhoto, { ...officerPhoto, url: null }] });
  render(<PhotoGallery caseRef="HEC-2026-0295" />);
  expect(await screen.findByTestId("photo-unavailable")).toHaveTextContent("photo.unavailable");
  expect(screen.getAllByRole("img")).toHaveLength(1);
  expect(screen.getByTestId("photo-source-officer")).toBeInTheDocument();
});

it("says a case has no photographs, distinctly from a failure to load them", async () => {
  mockList.mockResolvedValue({ ok: true, photos: [] });
  render(<PhotoGallery caseRef="HEC-2026-0295" />);
  expect(await screen.findByTestId("photo-empty")).toHaveTextContent("photo.none");
});

it("offers a retry when the photographs could not be loaded", async () => {
  mockList.mockResolvedValueOnce({ ok: false, failure: { reason: "network" } });
  render(<PhotoGallery caseRef="HEC-2026-0295" />);
  expect(await screen.findByTestId("photo-error")).toHaveTextContent("photo.loadFailed");

  fireEvent.click(screen.getByRole("button", { name: "photo.retry" }));
  expect(await screen.findByTestId("photo-gallery")).toBeInTheDocument();
});

it("names the deployment problem when there is no object store at all", async () => {
  // "Could not load" would send an administrator looking for a network fault that is not there.
  mockList.mockResolvedValue({ ok: false, failure: { reason: "storage-not-configured" } });
  render(<PhotoGallery caseRef="HEC-2026-0295" />);
  expect(await screen.findByTestId("photo-error")).toHaveTextContent("photo.storageUnavailable");
});

it("opens a photograph full size and closes again", async () => {
  // A thumbnail is not enough to judge damage from, and leaving the page to see one would lose
  // the approver's place in the case file.
  render(<PhotoGallery caseRef="HEC-2026-0295" />);
  fireEvent.click(await screen.findByRole("button", { name: "photo.expand.citizen" }));
  expect(screen.getByTestId("photo-lightbox")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "photo.close" }));
  expect(screen.queryByTestId("photo-lightbox")).not.toBeInTheDocument();
});

it("fetches nothing, and explains itself, without a case reference", async () => {
  // The officer's state before a case is open. There is no case to attach photographs to, so a
  // request would be a guaranteed 404.
  render(<PhotoGallery variant="officer" />);
  expect(screen.getByTestId("photo-notice-officer")).toHaveTextContent("photo.officerNotice");
  expect(mockList).not.toHaveBeenCalled();
});

describe("classifying the family's photograph (2026-10-02)", () => {
  it("offers 'Classify with AI' on the family's photographs only, and hands back the photo", async () => {
    const onClassify = jest.fn();
    render(<PhotoGallery caseRef="HEC-2026-0295" variant="officer" onClassify={onClassify} />);
    fireEvent.click(await screen.findByTestId("photo-classify-1"));
    expect(onClassify).toHaveBeenCalledWith(citizenPhoto);
    // The officer's own photograph is already the officer's input; offering it again would blur
    // which image the assessment rests on.
    expect(screen.queryByTestId("photo-classify-2")).not.toBeInTheDocument();
  });

  it("offers nothing to classify where no one may assess (admin, DS, a closed case)", async () => {
    render(<PhotoGallery caseRef="HEC-2026-0295" />);
    await screen.findByTestId("photo-gallery");
    expect(screen.queryByTestId("photo-classify-1")).not.toBeInTheDocument();
  });

  it("marks the photograph being assessed, and disables the buttons while work is in flight", async () => {
    render(
      <PhotoGallery caseRef="HEC-2026-0295" variant="officer" onClassify={jest.fn()} activePhotoId={1} classifyDisabled />,
    );
    const button = await screen.findByTestId("photo-classify-1");
    expect(button).toHaveTextContent("photo.classifySelected");
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toBeDisabled();
  });
});
