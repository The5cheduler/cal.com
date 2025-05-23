// eslint-disable-next-line no-restricted-imports
import { cloneDeep } from "lodash";

import { sendRescheduledSeatEmailAndSMS } from "@calcom/emails";
import type EventManager from "@calcom/lib/EventManager";
import { getTranslation } from "@calcom/lib/server/i18n";
import prisma from "@calcom/prisma";
import type { Person, CalendarEvent } from "@calcom/types/Calendar";

import { findBookingQuery } from "../../../handleNewBooking/findBookingQuery";
import lastAttendeeDeleteBooking from "../../lib/lastAttendeeDeleteBooking";
import type { RescheduleSeatedBookingObject, SeatAttendee, NewTimeSlotBooking } from "../../types";

const attendeeRescheduleSeatedBooking = async (
  rescheduleSeatedBookingObject: RescheduleSeatedBookingObject,
  seatAttendee: SeatAttendee,
  newTimeSlotBooking: NewTimeSlotBooking | null,
  originalBookingEvt: CalendarEvent,
  eventManager: EventManager
) => {
  const { tAttendees, bookingSeat, bookerEmail, evt, eventType } = rescheduleSeatedBookingObject;
  let { originalRescheduledBooking } = rescheduleSeatedBookingObject;

  seatAttendee["language"] = { translate: tAttendees, locale: bookingSeat?.attendee.locale ?? "en" };

  // Update the original calendar event by removing the attendee that is rescheduling
  if (originalBookingEvt && originalRescheduledBooking) {
    // Event would probably be deleted so we first check than instead of updating references
    const filteredAttendees = originalRescheduledBooking?.attendees.filter((attendee) => {
      return attendee.email !== bookerEmail;
    });
    const deletedReference = await lastAttendeeDeleteBooking(
      originalRescheduledBooking,
      filteredAttendees,
      originalBookingEvt
    );

    if (!deletedReference) {
      await eventManager.updateCalendarAttendees(originalBookingEvt, originalRescheduledBooking);
    }
  }

  // If there is no booking then remove the attendee from the old booking and create a new one
  if (!newTimeSlotBooking) {
    await prisma.attendee.delete({
      where: {
        id: seatAttendee?.id,
      },
    });

    // We don't want to trigger rescheduling logic of the original booking
    originalRescheduledBooking = null;

    return null;
  }

  // Need to change the new seat reference and attendee record to remove it from the old booking and add it to the new booking
  // https://stackoverflow.com/questions/4980963/database-insert-new-rows-or-update-existing-ones
  if (seatAttendee?.id && bookingSeat?.id) {
    await prisma.$transaction([
      prisma.attendee.update({
        where: {
          id: seatAttendee.id,
        },
        data: {
          bookingId: newTimeSlotBooking.id,
        },
      }),
      prisma.bookingSeat.update({
        where: {
          id: bookingSeat.id,
        },
        data: {
          bookingId: newTimeSlotBooking.id,
        },
      }),
    ]);
  }
  // Add the new attendees to the new time slot booking attendees
  for (const attendee of newTimeSlotBooking.attendees) {
    const translate = await getTranslation(attendee.locale ?? "en", "common");
    evt.attendees.push({
      email: attendee.email,
      name: attendee.name,
      timeZone: attendee.timeZone,
      language: { translate, locale: attendee.locale ?? "en" },
    });
  }

  const copyEvent = cloneDeep({ ...evt, iCalUID: newTimeSlotBooking.iCalUID });

  // Ensure attendee time zone is set correctly for all attendees in the event object
  if (seatAttendee && seatAttendee.timeZone) {
    copyEvent.attendees = copyEvent.attendees.map((a) =>
      a.email === seatAttendee.email ? { ...a, timeZone: seatAttendee.timeZone } : a
    );
  }

  await eventManager.updateCalendarAttendees(copyEvent, newTimeSlotBooking);

  // Respect disable standard emails setting for attendees
  if (!eventType?.metadata?.disableStandardEmails?.all?.attendee) {
    await sendRescheduledSeatEmailAndSMS(copyEvent, seatAttendee as Person, eventType.metadata);
  }

  const filteredAttendees = originalRescheduledBooking?.attendees.filter((attendee) => {
    return attendee.email !== bookerEmail;
  });
  await lastAttendeeDeleteBooking(originalRescheduledBooking, filteredAttendees, originalBookingEvt);

  const foundBooking = await findBookingQuery(newTimeSlotBooking.id);

  return { ...foundBooking, seatReferenceUid: bookingSeat?.referenceUid };
};

export default attendeeRescheduleSeatedBooking;
