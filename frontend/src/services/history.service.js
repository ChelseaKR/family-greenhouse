import http from "../http-common";

class HistoryDataService {
    get(id) {
        return http.get(`/greenhouse/history/${id}`);
    }

    update(id, data) {
        return http.put(`/greenhouse/history/${id}`, data);
    }

    delete(id) {
        return http.delete(`/greenhouse/history/${id}`);
    }

    deleteAll() {
        return http.delete(`/greenhouse/history`);
    }

    findByGreenhouse(greenhouse) {
        return http.get(`/history?greenhouse=${greenhouse}`);
    }
}

export default new HistoryDataService();