/**
 * The photo section, on both the administrator's case file and the officer's assessment screen.
 *
 * No photo-upload pipeline exists (PO decision 2026-07-13): the family's photographs stay on the
 * phone that submitted them. The previous copy — "Photo viewing isn't available yet" — read as an
 * unfinished feature, and the officer screen showed nothing at all, so an assessor concluded the
 * citizen's evidence had been lost. What these pin is that each screen now SAYS why, in words
 * suited to the person reading it.
 */
import { render, screen } from "@testing-library/react";
import { PhotoGallery } from "@/components/admin/PhotoGallery";

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }));

it("defaults to the administrator's wording", () => {
  render(<PhotoGallery />);
  expect(screen.getByText("photo.adminNotice")).toBeInTheDocument();
  expect(screen.getByTestId("photo-notice-admin")).toBeInTheDocument();
});

it("tells the officer to photograph the damage in front of them", () => {
  render(<PhotoGallery variant="officer" />);
  expect(screen.getByText("photo.officerNotice")).toBeInTheDocument();
  expect(screen.getByTestId("photo-notice-officer")).toBeInTheDocument();
});

it("no longer uses the 'not available yet' wording on either screen", () => {
  const { unmount } = render(<PhotoGallery />);
  expect(screen.queryByText("photo.unavailable")).not.toBeInTheDocument();
  unmount();
  render(<PhotoGallery variant="officer" />);
  expect(screen.queryByText("photo.unavailable")).not.toBeInTheDocument();
});
