/**
 * Pure helpers for Gallery album labels and selection.
 */

import type { GalleryAlbum } from "./catalog";

export function albumMemoryLabel(count: number): string {
  return count === 1 ? "1 memory" : `${count} memories`;
}

export function sortAlbumsForDisplay(albums: GalleryAlbum[]): GalleryAlbum[] {
  return [...albums].sort((a, b) => {
    if (a.is_default !== b.is_default) return b.is_default - a.is_default;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export function defaultAlbumId(albums: GalleryAlbum[]): number | null {
  const general = albums.find((album) => album.is_default);
  return general?.id ?? albums[0]?.id ?? null;
}

export function albumById(albums: GalleryAlbum[], id: number | null | undefined): GalleryAlbum | null {
  if (id == null) return null;
  return albums.find((album) => album.id === id) ?? null;
}
