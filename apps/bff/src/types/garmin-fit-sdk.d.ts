declare module '@garmin-fit/sdk' {
  export class Stream {
    static fromByteArray(bytes: number[]): Stream;
  }

  export class Decoder {
    constructor(stream: Stream);
    static isFIT(stream: Stream): boolean;
    isFIT(): boolean;
    checkIntegrity(): boolean;
    read(options?: {
      mesgListener?: (messageNumber: number, message: any) => void;
      applyScaleAndOffset?: boolean;
      expandSubFields?: boolean;
      expandComponents?: boolean;
      convertTypesToStrings?: boolean;
      convertDateTimesToDates?: boolean;
      includeUnknownData?: boolean;
      mergeHeartRates?: boolean;
    }): {
      messages: Record<string, any[]>;
      errors: any[];
    };
  }

  export const Profile: any;
  export const Utils: any;
}
