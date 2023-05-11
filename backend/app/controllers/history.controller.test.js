const db = require("../models");
const { events: Event } = db;
const historyController = require("./history.controller");
const uuid = require('uuid');

jest.mock("../models");

describe("History controller", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("findAll should get all history by greenhouse", async () => {
        const greenhouse = uuid.v4();
        const mockReq = {
            query: {
                greenhouse: greenhouse,
            },
        };
        const mockRes = {
            send: jest.fn(),
            status: jest.fn(() => mockRes),
        };

        const mockData = [
            {
                id: 1,
                task: {
                    id: 1,
                    plant: {
                        id: 1,
                        greenhouse: greenhouse,
                    },
                },
            },
        ];

        Event.findAll.mockResolvedValue(mockData);

        await historyController.findAll(mockReq, mockRes);

        expect(Event.findAll).toHaveBeenCalled();
        expect(mockRes.send).toHaveBeenCalledWith(mockData);
        expect(mockRes.status).not.toHaveBeenCalled();
    });

    test("findAll should handle errors", async () => {
        const greenhouse = uuid.v4();
        const mockReq = {
            query: {
                greenhouse: greenhouse,
            },
        };
        const mockRes = {
            send: jest.fn(),
            status: jest.fn(() => mockRes),
        };

        const mockError = new Error("Some error occurred while retrieving history.");
        Event.findAll.mockRejectedValue(mockError);

        try {
            await historyController.findAll(mockReq, mockRes);
        } catch (error) {
            expect(Event.findAll).toHaveBeenCalled();
            expect(mockRes.status).toHaveBeenCalledWith(500);
            expect(mockRes.send).toHaveBeenCalledWith({
                message: mockError.message,
            });
        }
    });
});
